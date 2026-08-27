/* pi-harbor v2.0.2 — English-first localization and provider catalog */
"use strict";

// The browser remains buildless, but feature-independent foundations live in
// small files loaded before this controller. This keeps deployment as simple
// as the original PWA while preventing storage, device, and display rules from
// being duplicated across future feature modules.
const foundation = window.piHarborFoundation;
const sessionUtils = window.piHarborSessionUtils;
if (!foundation || !sessionUtils) throw new Error("Pi Harbor foundation modules are missing");
const {
  SELECTED_KEY, SETTINGS_KEY, LEGACY_SETTINGS_KEY, LEGACY_SETTINGS_KEYS, SETTINGS_VERSION,
  DESIGN_THEMES, DESIGN_THEME_IDS, DEFAULT_SETTINGS,
  loadSelected, saveSelected, loadSettings, saveSettings,
  currentMachine: currentMachineFromList,
  machineDisplayName, machineDisplayHost, machineName: machineNameFromList,
} = foundation;
const { stripMd, fmtTime, fmtTokens, projectFolderName } = sessionUtils;

let machines = [];        // [{id,name,host,url,managed,self}] 由 GET /api/machines 下發
let selfId = null;
let selectedId = null;
let apiBase = "";         // "" = 本機；"/r/<id>" = 反代遠端

function currentMachine() { return currentMachineFromList(machines, selectedId); }
function machineName(id) { return machineNameFromList(machines, id); }

let currentHost = null; // boot() 由 /api/machine 校正（顯示用）

// ===========================================================================
// DOM
// ===========================================================================

const $ = (id) => document.getElementById(id);
const el = {
  login: $("login"), loginForm: $("login-form"), loginToken: $("login-token"),
  loginError: $("login-error"), loginMachine: $("login-machine"),
  app: $("app"),
  viewList: $("view-list"), viewChat: $("view-chat"), viewSettings: $("view-settings"), viewModelSettings: $("view-model-settings"),
  search: $("search"), btnRefresh: $("btn-refresh"),
  sessionList: $("session-list"), listEmpty: $("list-empty"),
  temporarySessionFilter: $("temporary-session-filter"), temporarySessionFilterLabel: $("temporary-session-filter-label"),
  temporarySessionCount: $("temporary-session-count"), showTemporarySessions: $("show-temporary-sessions"),
  fabNew: $("fab-new"), btnNew: $("btn-new"), btnNewProject: $("btn-new-project"), pullIndicator: $("pull-indicator"),
  machineSwitch: $("machine-switch"),
  btnBack: $("btn-back"), chatTitle: $("chat-title"), chatSub: $("chat-sub"),
  chatHeadInfo: $("chat-head-info"), streamDot: $("stream-dot"), thinkingStatus: $("thinking-status"), btnChatMenu: $("btn-chat-menu"),
  messages: $("messages"), scrollBottomBtn: $("scroll-bottom-btn"), queueNote: $("queue-note"),
  chatEmpty: $("chat-empty"), slashMenu: $("slash-menu"),
  input: $("input"), btnSend: $("btn-send"), btnAbort: $("btn-abort"), btnModel: $("btn-model"),
  sessionCount: $("session-count"), btnLayout: $("btn-layout"),
  composerModelLabel: $("composer-model-label"), composerThinking: $("composer-thinking"),
  btnOpenSettings: $("btn-open-settings"), btnSettingsBack: $("btn-settings-back"), btnModelSettingsBack: $("btn-model-settings-back"), modelSettingsOpen: $("model-settings-open"), modelSettingsSummary: $("model-settings-summary"),
  machineList: $("machine-list"), machineAdd: $("machine-add"), machinePair: $("machine-pair"), machineDialog: $("machine-dialog"), machineDialogTitle: $("machine-dialog-title"), machineStandardFields: $("machine-standard-fields"), machineName: $("machine-name"), machineUrl: $("machine-url"), machinePort: $("machine-port"), machinePortLabel: $("machine-port-label"), machineHost: $("machine-host"), machineStatusNote: $("machine-status-note"), machineFormError: $("machine-form-error"), machinePairArea: $("machine-pair-area"), machinePairCode: $("machine-pair-code"), machinePairJoin: $("machine-pair-join"), machinePairOfferArea: $("machine-pair-offer-area"), machinePairOffer: $("machine-pair-offer"), machinePairGenerate: $("machine-pair-generate"), machineRestart: $("machine-restart"), machineSave: $("machine-save"), machineDelete: $("machine-delete"), machineTest: $("machine-test"), machineCancel: $("machine-cancel"), machineCancelBottom: $("machine-cancel-bottom"),
  setMachineName: $("set-machine-name"), setMachineHost: $("set-machine-host"), setPiVersion: $("set-pi-version"),
  setSessionCount: $("set-session-count"), btnLogout: $("btn-logout"), btnResetSettings: $("btn-reset-settings"), btnOpenOnboarding: $("btn-open-onboarding"), setupGuideTitle: $("setup-guide-title"), setupGuideSubtitle: $("setup-guide-subtitle"),
  setAutoUpdate: $("set-auto-update"), updateStatusCopy: $("update-status-copy"), updateCheck: $("update-check"), updateCheckStatus: $("update-check-status"),
  setLocale: $("set-locale"), setTheme: $("set-theme"), setDesignTheme: $("theme-choices"), setSidebarWidth: $("set-sidebar-width"), setSidebarWidthValue: $("set-sidebar-width-value"), setFontScale: $("set-font-scale"), setFontScaleValue: $("set-font-scale-value"), setCompact: $("set-compact"), setGroup: $("set-group"),
  btnImg: $("btn-img"), fileInput: $("file-input"), imgPreview: $("img-preview"),
  setReducedMotion: $("set-reduced-motion"), setThinking: $("set-thinking"),
  modelVisibilityList: $("model-visibility-list"), modelVisibilityRefresh: $("model-visibility-refresh"),
  modelFilter: $("model-filter"), modelListSummary: $("model-list-summary"), providerAdd: $("provider-add"),
  providerDialog: $("provider-dialog"), providerDialogTitle: $("provider-dialog-title"), providerId: $("provider-id"),
  providerApi: $("provider-api"), providerBaseUrl: $("provider-base-url"), providerApiKey: $("provider-api-key"),
  providerModels: $("provider-models"), providerFormError: $("provider-form-error"), providerSave: $("provider-save"),
  providerCancel: $("provider-cancel"), providerCancelBottom: $("provider-cancel-bottom"), providerDelete: $("provider-delete"),
  providerSimpleFlow: $("provider-simple-flow"), providerPresetList: $("provider-preset-list"),
  providerFilter: $("provider-filter"),
  providerAuthOptions: $("provider-auth-options"), providerSelectedName: $("provider-selected-name"),
  providerSelectedDescription: $("provider-selected-description"), providerAuthAccount: $("provider-auth-account"),
  providerAuthApi: $("provider-auth-api"), providerApiKeyEntry: $("provider-api-key-entry"), providerSimpleApiKey: $("provider-simple-api-key"), providerApiKeyBack: $("provider-api-key-back"), providerApiKeySave: $("provider-api-key-save"), providerFreeStart: $("provider-free-start"), providerAuthRemove: $("provider-auth-remove"), providerAuthBack: $("provider-auth-back"),
  providerSimpleStatus: $("provider-simple-status"), providerSwitchDevice: $("provider-switch-device"), providerAdvancedToggle: $("provider-advanced-toggle"),
  providerAdvancedFields: $("provider-advanced-fields"),
  newDialog: $("new-dialog"), newCwd: $("new-cwd"), newName: $("new-name"),
  newCancel: $("new-cancel"), newStart: $("new-start"), newFolderUp: $("new-folder-up"),
  newFolderHome: $("new-folder-home"), newFolderPath: $("new-folder-path"), newFolderList: $("new-folder-list"),
  saSheet: $("session-action-sheet"), saTitle: $("sa-title"),
  saModel: $("sa-model"), saRename: $("sa-rename"), saDelete: $("sa-delete"), saCancel: $("sa-cancel"),
  projectActionSheet: $("project-action-sheet"), projectActionTitle: $("pa-title"),
  projectActionPin: $("pa-pin"), projectActionEdit: $("pa-edit"), projectActionReveal: $("pa-reveal"),
  projectActionWorktree: $("pa-worktree"), projectActionArchive: $("pa-archive"), projectActionRemove: $("pa-remove"),
  projectActionCancel: $("pa-cancel"), projectActionClose: $("pa-cancel-close"),
  modelSheet: $("model-sheet"), modelList: $("model-list"),
  thinkingSelect: $("thinking-select"), modelClose: $("model-close"),
  renameDialog: $("rename-dialog"), renameInput: $("rename-input"),
  renameCancel: $("rename-cancel"), renameSave: $("rename-save"),
  projectRenameDialog: $("project-rename-dialog"), projectRenameTitle: $("project-rename-title"),
  projectRenameInput: $("project-rename-input"), projectRenameCancel: $("project-rename-cancel"),
  projectRenameSave: $("project-rename-save"),
  extensionUiSheet: $("extension-ui-sheet"), extensionUiKind: $("extension-ui-kind"),
  extensionUiTitle: $("extension-ui-title"), extensionUiMessage: $("extension-ui-message"),
  extensionUiOptions: $("extension-ui-options"), extensionUiInput: $("extension-ui-input"),
  extensionUiEditor: $("extension-ui-editor"), extensionUiCancel: $("extension-ui-cancel"),
  extensionUiSubmit: $("extension-ui-submit"),
  imageLightbox: $("image-lightbox"), imageLightboxImg: $("image-lightbox-img"),
  imageLightboxCaption: $("image-lightbox-caption"), imageLightboxClose: $("image-lightbox-close"),
  onboarding: $("onboarding"), onboardingClose: $("onboarding-close"), onboardingEyebrow: $("onboarding-eyebrow"), onboardingTitle: $("onboarding-title"), onboardingBody: $("onboarding-body"), onboardingPoints: $("onboarding-points"), onboardingProgress: document.querySelectorAll("#onboarding .onboarding-progress span"), onboardingPreferences: $("onboarding-preferences"), onboardingLanguage: $("onboarding-language"), onboardingLanguageLabel: $("onboarding-language-label"), onboardingAppearance: $("onboarding-appearance"), onboardingAppearanceLabel: $("onboarding-appearance-label"), onboardingBack: $("onboarding-back"), onboardingSkip: $("onboarding-skip"), onboardingNext: $("onboarding-next"),
  toastWrap: $("toast-wrap"),
};

// ===========================================================================
// 狀態
// ===========================================================================

let sessionsCache = [];
let sessionRenderLimit = 120;
let temporarySessionCount = 0;
const collapsedProjects = new Set();
const expandedProjectSessions = new Set();
const PROJECT_SESSION_PREVIEW_LIMIT = 3;
let rpc = null;              // {sid, es, streaming, queued}
let pendingAssistant = null;
let liveToolCards = new Map();
let liveActivity = null;     // 目前工作輪次的整組 thinking／tool 紀錄
let settings = loadSettings();
let modelCatalog = [];
let configuredProviders = [];
let providerCatalog = [];
let providerCatalogLoading = false;
let providerCatalogRequest = null;
let providerCatalogReadOnly = false;
let providerCatalogNotice = "";
let providerCatalogMachine = null;
let modelCatalogMachine = null;
let modelCatalogLoading = false;
let modelCatalogRequest = null;
const expandedModelProviders = new Set();
const collapsedProviderCategories = new Set(["free", "paid", "account"]);
let providerDialogMode = "add";
let providerDialogExisting = null;
let providerDialogPreset = null;
let machineDialogExisting = null;
let machineStatuses = new Map();
let machineDialogDeviceSettings = null;
let machineDialogRestartRequired = false;
let machineDialogMode = "edit";
let providerAuthRun = null;
let providerAuthStream = null;
let providerAuthRequest = null;
let providerAuthNotice = "";
let providerAuthUrl = "";
let viewGeneration = 0; // 防止快速切換 session 時，舊 request／SSE 回寫到新畫面
let refreshRequest = null;
let refreshSequence = 0;
let autoScrollPinned = true;
let scrollFrame = null;
let sessionUsage = { tokens: 0, cost: 0 };
let sessionUsageFooter = null;
let extensionUiRequest = null;
let activityWatchdog = null;
let expandedPinnedSessions = false;
const ONBOARDING_KEY = "piharbor.onboarding.v1";
let onboardingStep = 0;
const ACTIVITY_STALE_MS = 45_000;

// ===========================================================================
// Toast
// ===========================================================================

function toast(msg, isError = false) {
  const t = document.createElement("div");
  t.className = "toast" + (isError ? " err" : "");
  t.textContent = msg;
  el.toastWrap.appendChild(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 350); }, 2400);
}

// ===========================================================================
// API（apiBase："" 本機 或 "/r/<id>" 反代遠端）
// ===========================================================================

async function api(path, opts = {}) {
  const res = await fetch(apiBase + path, { credentials: "same-origin", ...opts });
  if (res.status === 401) { showLogin(); throw new Error("unauthorized"); }
  if (!res.ok && res.status !== 204) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch {}
    const error = new Error(msg);
    error.status = res.status;
    error.path = apiBase + path;
    throw error;
  }
  return res.status === 204 ? null : res.json();
}
const post = (path, body) => api(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

/** 通用 RPC 指令（模型切換 / thinking level / compact 等） */
function rpcCmd(sid, command) {
  return post("/api/rpc-cmd", { sid, command });
}

// ===========================================================================
// 主題 / 外觀
// ===========================================================================

function applyAppearance() {
  const html = document.documentElement;
  const resolvedTheme = settings.theme === "auto"
    ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : settings.theme;
  html.dataset.theme = resolvedTheme;
  html.dataset.themePreference = settings.theme;
  html.dataset.designTheme = DESIGN_THEME_IDS.has(settings.designTheme) ? settings.designTheme : DEFAULT_SETTINGS.designTheme;
  html.style.setProperty("--oc-sidebar", `${settings.sidebarWidth}px`);
  html.style.fontSize = `${settings.fontScale}%`;
  document.body.classList.toggle("compact", !!settings.compact);
  html.classList.toggle("reduced-motion", !!settings.reducedMotion);
  window.piI18n?.setLocale(settings.locale || "en");
}

matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => {
  if (settings.theme === "auto") applyAppearance();
});

// ===========================================================================
// 登入 / 登出
// ===========================================================================

function showLogin() {
  closeChat(true);
  el.app.classList.add("hidden");
  el.login.classList.remove("hidden");
}

async function boot() {
  applyAppearance();
  // 1) 先拿本源機器清單（server 端權威）
  try {
    const data = await api("/api/machines");
    machines = data.machines || [];
    selfId = data.current;
  } catch {}
  // 2) 選中：上次選的 → 本機 → 第一台
  selectedId = loadSelected() && machines.some(m => m.id === loadSelected())
    ? loadSelected() : (selfId || (machines[0] && machines[0].id));
  applyApiBase();
  renderMachineSwitch();
  try {
    const m = await api("/api/machine");
    const loginMachine = machines.find((machine) => machine.self) || machines.find((machine) => machine.name === m.machine);
    el.loginMachine.textContent = machineDisplayName(loginMachine) || machineDisplayName(m.machine);
    currentHost = m.machine;
    window._piHome = m.home || "";
    if (m.authed) { enterApp(); return; }
  } catch {}
  showLogin();
}

el.loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  el.loginError.classList.add("hidden");
  try {
    // 登入永遠打本源（cookie 屬於本源；遠端由 server relay 認證）
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: el.loginToken.value }),
      credentials: "same-origin",
    });
    if (res.status === 401) throw new Error("unauthorized");
    if (!res.ok && res.status !== 204) throw new Error(res.statusText);
    el.loginToken.value = "";
    enterApp();
  } catch (err) {
    el.loginError.textContent = err.message === "unauthorized" ? "Token 不正確" : err.message;
    el.loginError.classList.remove("hidden");
  }
});

function enterApp() {
  el.login.classList.add("hidden");
  el.app.classList.remove("hidden");
  // 登入後重新拉機器清單（未登入時 /api/machines 會 401）
  api("/api/machines").then((data) => {
    machines = data.machines || [];
    selfId = data.current;
    if (!machines.some(m => m.id === selectedId)) {
      selectedId = selfId || (machines[0] && machines[0].id);
      applyApiBase();
      renderMachineSwitch();
    }
    showList();
    loadVersion();
    setTimeout(() => openOnboarding(false), 350);
  }).catch(() => { showList(); refreshSessions(); setTimeout(() => openOnboarding(false), 350); });
}

function loadVersion() {
  const generation = viewGeneration;
  const baseAtStart = apiBase;
  window._piVersion = "…";
  api("/api/version").then(v => {
    if (generation !== viewGeneration || baseAtStart !== apiBase) return;
    window._piVersion = v.version;
    if (!el.viewSettings.classList.contains("hidden")) renderSettings();
  }).catch(() => {});
  api("/api/machine").then(m => {
    if (generation !== viewGeneration || baseAtStart !== apiBase) return;
    currentHost = m.machine || currentHost;
    window._piHome = m.home || window._piHome || "";
    if (!el.viewSettings.classList.contains("hidden")) renderSettings();
  }).catch(() => {});
}

// ---- SPA 機器切換：零頁面跳轉，只切資料源 ----
function applyApiBase() {
  apiBase = selectedId === selfId ? "" : "/r/" + selectedId;
}

function switchMachine(id, silent) {
  if (!machines.some(m => m.id === id)) return;
  const generation = ++viewGeneration;
  const wasChatOpen = !el.viewChat.classList.contains("hidden");
  const preserveRunning = !!(rpc && (rpc.streaming || rpc.connectionLost));
  closeChat(preserveRunning); // 切機器時不殺正在執行的工作，閒置 RPC 則正常關閉
  el.viewChat.classList.add("hidden");
  el.viewChat.style.transform = "";
  el.viewSettings.classList.add("hidden");
  el.viewModelSettings.classList.add("hidden");
  selectedId = id;
  saveSelected(id);
  applyApiBase();
  modelCatalog = [];
  configuredProviders = [];
  modelCatalogMachine = null;
  providerCatalog = [];
  providerCatalogReadOnly = false;
  providerCatalogNotice = "";
  providerCatalogMachine = null;
  providerCatalogRequest = null;
  providerCatalogLoading = false;
  renderModelSettingsSummary();
  if (modelCatalogRequest) modelCatalogRequest.abort();
  modelCatalogRequest = null;
  modelCatalogLoading = false;
  currentSessionFile = null;
  sessionsCache = [];
  temporarySessionCount = 0;
  renderTemporarySessionFilter(0);
  renderMachineSwitch();
  showListSilent();
  void generation;
  refreshSessions();
  loadVersion();
  if (!silent) toast(`已切換到 ${machineName(id)}`);
  void wasChatOpen;
}

function showListSilent() {
  el.viewList.classList.remove("hidden");
  el.viewSettings.classList.add("hidden");
  el.viewModelSettings.classList.add("hidden");
  if (isDesktop()) showChatEmpty();
}

// ---- 頂欄機器切換下拉 ----
function renderMachineSwitch() {
  if (!el.machineSwitch) return;
  el.machineSwitch.innerHTML = "";
  for (const m of machines) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = machineDisplayName(m);
    if (m.id === selectedId) opt.selected = true;
    el.machineSwitch.appendChild(opt);
  }
}
el.machineSwitch?.addEventListener("change", () => {
  switchMachine(el.machineSwitch.value);
});

async function logout() {
  try { await post("/api/logout", {}); } catch {}
  location.reload();
}
el.btnLogout.addEventListener("click", logout);

// ===========================================================================
// 視圖切換
// ===========================================================================

function isDesktop() { return matchMedia("(min-width: 980px)").matches; }

function showList() {
  ++viewGeneration;
  const wasStreaming = !!(rpc && (rpc.streaming || rpc.connectionLost));
  closeChat(wasStreaming); // streaming 中保留進程繼續跑；閒置對話離開時關閉
  if (!isDesktop()) el.viewChat.classList.add("hidden");
  else showChatEmpty();
  el.viewChat.style.transform = "";
  el.viewSettings.classList.add("hidden");
  el.viewModelSettings.classList.add("hidden");
  el.viewList.classList.remove("hidden");
  refreshSessions();
}
el.btnBack.addEventListener("click", showList);

function showChatEmpty() {
  el.messages.innerHTML = '';
  resetSessionUsage();
  if (el.chatEmpty) {
    el.messages.appendChild(el.chatEmpty);
    el.chatEmpty.classList.remove("hidden");
  }
}
function hideChatEmpty() {
  if (el.chatEmpty && el.chatEmpty.parentElement) el.chatEmpty.remove();
}

function showSettings() {
  renderSettings();
  el.viewModelSettings.classList.add("hidden");
  void loadModelVisibility();
  el.viewSettings.classList.remove("hidden");
  el.viewSettings.classList.add("slide-in");
  setTimeout(() => el.viewSettings.classList.remove("slide-in"), 250);
}
el.btnOpenSettings.addEventListener("click", showSettings);
el.btnSettingsBack.addEventListener("click", () => {
  el.viewSettings.classList.add("hidden");
});
function showModelSettings() {
  el.viewSettings.classList.add("hidden");
  el.viewModelSettings.classList.remove("hidden");
  el.viewModelSettings.classList.add("slide-in");
  setTimeout(() => el.viewModelSettings.classList.remove("slide-in"), 250);
  void loadModelVisibility();
}
el.modelSettingsOpen?.addEventListener("click", showModelSettings);
el.btnModelSettingsBack?.addEventListener("click", () => {
  el.viewModelSettings.classList.add("hidden");
  el.viewSettings.classList.remove("hidden");
  renderSettings();
});

// ===========================================================================
// Session 列表 + 下拉刷新 + 長按動作
// ===========================================================================

async function refreshSessions() {
  const generation = viewGeneration;
  const baseAtStart = apiBase;
  const sequence = ++refreshSequence;
  if (refreshRequest) refreshRequest.abort();
  refreshRequest = new AbortController();
  try {
    const includeTemporary = settings.showTemporarySessions ? "1" : "0";
    const data = await api(`/api/sessions?includeTemporary=${includeTemporary}`, { signal: refreshRequest.signal });
    if (sequence !== refreshSequence || generation !== viewGeneration || baseAtStart !== apiBase) return;
    sessionsCache = data.sessions || [];
    temporarySessionCount = Math.max(0, Number(data.temporarySessionCount) || 0);
    if (el.sessionCount) el.sessionCount.textContent = String(sessionsCache.length);
    renderTemporarySessionFilter(temporarySessionCount);
    renderSessionList(el.search.value);
  } catch (e) {
    if (e.name !== "AbortError") { /* unauthorized 已處理 */ }
  } finally {
    if (sequence === refreshSequence) refreshRequest = null;
  }
}

function projectDisplayName(cwd) {
  const key = String(cwd || "(unknown)");
  const alias = settings.projectAliases?.[key];
  return typeof alias === "string" && alias.trim() ? alias.trim() : projectFolderName(key);
}

function projectIsPinned(cwd) {
  return Array.isArray(settings.projectPins) && settings.projectPins.includes(String(cwd || ""));
}

function projectIsRemoved(cwd) {
  return Array.isArray(settings.removedProjects) && settings.removedProjects.includes(String(cwd || ""));
}

function saveProjectListSettings(patch) {
  settings = saveSettings(patch);
  applyAppearance();
  renderSessionList(el.search?.value || "");
}

function renderTemporarySessionFilter(count = temporarySessionCount) {
  if (!el.temporarySessionFilter) return;
  const total = Math.max(0, Number(count) || 0);
  const available = total > 0 || settings.showTemporarySessions;
  el.temporarySessionFilter.classList.toggle("hidden", !available);
  if (!available) return;
  if (el.showTemporarySessions) el.showTemporarySessions.checked = !!settings.showTemporarySessions;
  if (el.temporarySessionFilterLabel) {
    el.temporarySessionFilterLabel.textContent = window.piI18n?.t(settings.showTemporarySessions
      ? "Hide Sub Agent sessions" : "Show Sub Agent sessions") || (settings.showTemporarySessions
      ? "Hide Sub Agent sessions" : "Show Sub Agent sessions");
  }
  if (el.temporarySessionCount) {
    el.temporarySessionCount.textContent = window.piI18n?.t("Temporary sessions: {count}", { count: total }) || `Temporary sessions: ${total}`;
  }
}

function projectIconButton(icon, title, aria) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "project-group-action";
  button.title = title;
  button.setAttribute("aria-label", aria || title);
  button.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${icon}"></use></svg>`;
  return button;
}

function sessionIsPinned(session) {
  const file = typeof session === "string" ? session : session?.file;
  return !!file && Array.isArray(settings.sessionPins) && settings.sessionPins.includes(file);
}

function sessionIconButton(icon, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "session-item-action";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${icon}"></use></svg>`;
  return button;
}

function closeSwipedSessionItems(except = null) {
  document.querySelectorAll("#view-list .session-item.swiped").forEach((item) => {
    if (item !== except) item.classList.remove("swiped");
  });
}

function renderSessionList(q) {
  const query = (q || "").trim().toLowerCase();
  const list = sessionsCache.filter(s => !query ||
    (s.name || "").toLowerCase().includes(query) ||
    (s.preview || "").toLowerCase().includes(query) ||
    (s.cwd || "").toLowerCase().includes(query));
  const orderedList = [...list].sort((a, b) => Number(sessionIsPinned(b)) - Number(sessionIsPinned(a)) || (Number(b.mtimeMs) || 0) - (Number(a.mtimeMs) || 0));
  const visibleList = settings.groupByProject ? orderedList : orderedList.slice(0, sessionRenderLimit);
  el.sessionList.classList.toggle("grouped", !!settings.groupByProject);
  el.sessionList.innerHTML = "";
  el.listEmpty.classList.toggle("hidden", list.length > 0);

  const makeItem = (s) => {
    const li = document.createElement("li");
    li.className = "session-item" + (s.file === currentSessionFile ? " selected" : "");
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    const rawName = s.name || s.preview?.split("\n")[0] || "";
    const name = stripMd(rawName).slice(0, 70) || (window.piI18n?.t("(Untitled)") || "(Untitled)");
    const usage = [
      s.tokens ? `${fmtTokens(s.tokens)} tok` : "",
      s.cost ? "$" + s.cost.toFixed(2) : "",
    ].filter(Boolean).join(" · ");
    li.innerHTML = `
      <span class="session-pin-indicator hidden" role="img"></span>
      <span class="session-item-copy">
        <span class="s-name"></span>
        <span class="s-meta"></span>
      </span>
      <span class="session-item-actions"></span>`;
    li.querySelector(".s-name").textContent = name;
    const meta = li.querySelector(".s-meta");
    meta.textContent = usage;
    meta.classList.toggle("hidden", !usage);
    const pinned = sessionIsPinned(s);
    li.classList.toggle("session-pinned", pinned);
    const pinIndicator = li.querySelector(".session-pin-indicator");
    if (pinned) {
      pinIndicator.classList.remove("hidden");
      pinIndicator.title = projectActionText("Pinned");
      pinIndicator.setAttribute("aria-label", projectActionText("Pinned"));
      pinIndicator.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-pin"></use></svg>`;
    }
    const itemActions = li.querySelector(".session-item-actions");
    const pinButton = sessionIconButton("i-pin", projectActionText(pinned ? "Unpin" : "Pin"));
    const archiveButton = sessionIconButton("i-archive", projectActionText("Archive chats"));
    itemActions.append(pinButton, archiveButton);
    const stopItemAction = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    pinButton.addEventListener("click", (event) => {
      stopItemAction(event);
      const pins = new Set(settings.sessionPins || []);
      if (pins.has(s.file)) pins.delete(s.file);
      else pins.add(s.file);
      settings = saveSettings({ sessionPins: [...pins] });
      closeSwipedSessionItems();
      renderSessionList(el.search.value);
    });
    archiveButton.addEventListener("click", async (event) => {
      stopItemAction(event);
      if (!window.confirm(`${projectActionText("Archive chats")}?`)) return;
      try {
        await post("/api/session-action", { action: "archive", file: s.file });
        const isCurrent = currentSessionFile === s.file && !el.viewChat.classList.contains("hidden");
        toast(projectActionText("Archived chats"));
        if (isCurrent) showList();
        else refreshSessions();
      } catch (error) {
        toast(error.message || projectActionText("Could not archive chats"), true);
      }
    });
    let lpTimer = null, longPressed = false, swipeConsumed = false, touchStartX = 0, touchStartY = 0;
    li.addEventListener("touchstart", (event) => {
      const touch = event.changedTouches?.[0];
      touchStartX = touch?.clientX || 0;
      touchStartY = touch?.clientY || 0;
      swipeConsumed = false;
      longPressed = false;
      lpTimer = setTimeout(() => { longPressed = true; openSessionActions(s); }, 550);
    }, { passive: true });
    li.addEventListener("touchmove", (event) => {
      const touch = event.changedTouches?.[0];
      if (!touch) return;
      const dx = touchStartX - touch.clientX;
      const dy = touchStartY - touch.clientY;
      if (Math.abs(dx) < 18 || Math.abs(dx) <= Math.abs(dy)) return;
      clearTimeout(lpTimer);
      swipeConsumed = true;
      if (dx > 26) {
        closeSwipedSessionItems(li);
        li.classList.add("swiped");
      } else if (dx < -26) {
        li.classList.remove("swiped");
      }
      event.preventDefault();
    }, { passive: false });
    li.addEventListener("touchend", () => clearTimeout(lpTimer));
    li.addEventListener("touchcancel", () => clearTimeout(lpTimer));
    li.addEventListener("contextmenu", (e) => { e.preventDefault(); openSessionActions(s); });
    li.addEventListener("click", () => {
      if (swipeConsumed) {
        swipeConsumed = false;
        return;
      }
      if (li.classList.contains("swiped")) {
        li.classList.remove("swiped");
        return;
      }
      if (!longPressed) openExisting(s);
    });
    li.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && !longPressed) {
        event.preventDefault();
        openExisting(s);
      }
    });
    return li;
  };

  if (settings.groupByProject) {
    // Project folder → sessions：即使正在搜尋，也保留資料夾階層。
    const groups = new Map();
    const pinnedItems = visibleList.filter((s) => sessionIsPinned(s));
    for (const s of visibleList) {
      if (sessionIsPinned(s)) continue;
      const key = s.cwd || "(unknown)";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
    if (pinnedItems.length) {
      const pinnedGroup = document.createElement("li");
      pinnedGroup.className = "project-group pinned-session-group";
      const pinnedHeader = document.createElement("div");
      pinnedHeader.className = "project-group-header pinned-session-header";
      const pinnedLabel = document.createElement("div");
      pinnedLabel.className = "pinned-session-label";
      pinnedLabel.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-pin"></use></svg><strong></strong>`;
      pinnedLabel.querySelector("strong").textContent = projectActionText("Pinned");
      const pinnedCount = document.createElement("span");
      pinnedCount.className = "project-group-count";
      pinnedCount.textContent = String(pinnedItems.length);
      pinnedHeader.append(pinnedLabel, pinnedCount);
      const pinnedChildren = document.createElement("ul");
      pinnedChildren.className = "project-group-items";
      const pinnedVisibleItems = expandedPinnedSessions ? pinnedItems : pinnedItems.slice(0, PROJECT_SESSION_PREVIEW_LIMIT);
      for (const s of pinnedVisibleItems) pinnedChildren.appendChild(makeItem(s));
      if (pinnedItems.length > PROJECT_SESSION_PREVIEW_LIMIT) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "project-session-toggle";
        toggle.textContent = expandedPinnedSessions
          ? (window.piI18n?.t("Show less") || "Show less")
          : `${window.piI18n?.t("Show more") || "Show more"} (${pinnedItems.length - PROJECT_SESSION_PREVIEW_LIMIT})`;
        toggle.setAttribute("aria-expanded", String(expandedPinnedSessions));
        toggle.addEventListener("click", () => {
          expandedPinnedSessions = !expandedPinnedSessions;
          renderSessionList(el.search.value);
        });
        pinnedChildren.appendChild(toggle);
      }
      pinnedGroup.append(pinnedHeader, pinnedChildren);
      el.sessionList.appendChild(pinnedGroup);
    }
    const newest = (items) => Math.max(...items.map(x => Number(x.mtimeMs) || 0));
    const sorted = [...groups.entries()]
      .filter(([cwd]) => !projectIsRemoved(cwd) || !!query)
      .sort((a, b) => {
        const pinOrder = Number(projectIsPinned(b[0])) - Number(projectIsPinned(a[0]));
        return pinOrder || newest(b[1]) - newest(a[1]);
    });
    for (const [cwd, items] of sorted) {
      const collapsed = collapsedProjects.has(cwd);
      const expanded = expandedProjectSessions.has(cwd);
      const orderedItems = [...items].sort((a, b) => Number(sessionIsPinned(b)) - Number(sessionIsPinned(a)) || (Number(b.mtimeMs) || 0) - (Number(a.mtimeMs) || 0));
      const visibleItems = expanded ? orderedItems : orderedItems.slice(0, PROJECT_SESSION_PREVIEW_LIMIT);
      const group = document.createElement("li");
      group.className = "project-group" + (collapsed ? " collapsed" : "");
      const header = document.createElement("div");
      header.className = "project-group-header";
      const collapseButton = document.createElement("button");
      collapseButton.type = "button";
      collapseButton.className = "project-group-main";
      collapseButton.setAttribute("aria-expanded", String(!collapsed));
      collapseButton.innerHTML = `<span class="project-folder-icon"><svg class="icon"><use href="#i-folder-filled"></use></svg></span><span class="project-group-copy"><strong></strong></span>`;
      collapseButton.querySelector("strong").textContent = projectDisplayName(cwd);
      collapseButton.title = cwd === "(unknown)" ? projectDisplayName(cwd) : cwd;
      const children = document.createElement("ul");
      children.className = "project-group-items";
      children.id = `project-sessions-${[...groups.keys()].indexOf(cwd)}`;
      children.hidden = collapsed;
      collapseButton.setAttribute("aria-controls", children.id);
      for (const s of visibleItems) children.appendChild(makeItem(s));
      if (items.length > PROJECT_SESSION_PREVIEW_LIMIT) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "project-session-toggle";
        toggle.textContent = expanded
          ? (window.piI18n?.t("Show less") || "Show less")
          : `${window.piI18n?.t("Show more") || "Show more"} (${items.length - PROJECT_SESSION_PREVIEW_LIMIT})`;
        toggle.setAttribute("aria-expanded", String(expanded));
        toggle.addEventListener("click", (event) => {
          event.stopPropagation();
          if (expandedProjectSessions.has(cwd)) expandedProjectSessions.delete(cwd);
          else expandedProjectSessions.add(cwd);
          renderSessionList(el.search.value);
        });
        children.appendChild(toggle);
      }
      const toggleCollapsed = () => {
        if (collapsedProjects.has(cwd)) collapsedProjects.delete(cwd);
        else collapsedProjects.add(cwd);
        renderSessionList(el.search.value);
      };
      collapseButton.addEventListener("click", toggleCollapsed);
      const actions = document.createElement("div");
      actions.className = "project-group-actions";
      if (cwd !== "(unknown)") {
        const newButton = projectIconButton("i-plus", window.piI18n?.t("New session in project") || "New session in project");
        newButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          openNewDialog(cwd);
        });
        const moreButton = projectIconButton("i-ellipsis", window.piI18n?.t("More project actions") || "More project actions");
        moreButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          openProjectActions(cwd, projectDisplayName(cwd));
        });
        actions.append(newButton, moreButton);
      }
      const arrowButton = document.createElement("button");
      arrowButton.type = "button";
      arrowButton.className = "project-group-chevron-button";
      arrowButton.setAttribute("aria-expanded", String(!collapsed));
      arrowButton.setAttribute("aria-controls", children.id);
      arrowButton.title = collapsed ? (window.piI18n?.t("Expand") || "Expand") : (window.piI18n?.t("Collapse") || "Collapse");
      arrowButton.setAttribute("aria-label", arrowButton.title);
      arrowButton.innerHTML = `<span class="project-group-chevron"><svg class="icon"><use href="#i-chevron-down"></use></svg></span>`;
      arrowButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        toggleCollapsed();
      });
      const trailing = document.createElement("div");
      trailing.className = "project-group-trailing";
      const count = document.createElement("span");
      count.className = "project-group-count";
      count.textContent = String(items.length);
      trailing.append(count, arrowButton);
      header.append(collapseButton, actions, trailing);
      group.append(header, children);
      el.sessionList.appendChild(group);
    }
  } else {
    for (const s of visibleList) el.sessionList.appendChild(makeItem(s));
  }
  if (!settings.groupByProject && visibleList.length < list.length) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "history-load-button session-load-more";
    more.textContent = `${window.piI18n?.t("Show more") || "Show more"} (${list.length - visibleList.length})`;
    more.setAttribute("aria-label", window.piI18n?.t("Show more sessions") || "Show more sessions");
    more.addEventListener("click", () => {
      sessionRenderLimit += 120;
      renderSessionList(el.search.value);
    });
    const moreWrap = document.createElement("li");
    moreWrap.className = "session-load-more-wrap";
    moreWrap.appendChild(more);
    el.sessionList.appendChild(moreWrap);
  }
}
el.search.addEventListener("input", () => { sessionRenderLimit = 120; renderSessionList(el.search.value); });
el.btnRefresh.addEventListener("click", refreshSessions);
el.showTemporarySessions?.addEventListener("change", () => {
  settings = saveSettings({ showTemporarySessions: el.showTemporarySessions.checked });
  if (!settings.showTemporarySessions) sessionsCache = sessionsCache.filter((session) => !session.isTemporary);
  if (el.sessionCount) el.sessionCount.textContent = String(sessionsCache.length);
  renderTemporarySessionFilter(temporarySessionCount);
  renderSessionList(el.search.value);
  void refreshSessions();
});
el.btnLayout?.addEventListener("click", () => {
  settings = saveSettings({ groupByProject: !settings.groupByProject });
  renderSessionList(el.search.value);
  toast(settings.groupByProject ? "已按專案分組" : "已切換為平面列表");
});

// ---- 下拉刷新 ----
(() => {
  const THRESHOLD = 70;
  let startY = 0, pulling = false, ready = false;
  el.sessionList.addEventListener("touchstart", (e) => {
    if (el.sessionList.scrollTop <= 0) {
      startY = e.touches[0].clientY;
      pulling = true; ready = false;
    }
  }, { passive: true });
  el.sessionList.addEventListener("touchmove", (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) { el.pullIndicator.style.height = "0"; el.pullIndicator.classList.remove("ready"); return; }
    const h = Math.min(dy * 0.45, 64);
    el.pullIndicator.style.height = h + "px";
    ready = h >= 28;
    el.pullIndicator.classList.toggle("ready", ready);
  }, { passive: true });
  el.sessionList.addEventListener("touchend", async () => {
    if (!pulling) return;
    pulling = false;
    if (ready) {
      el.pullIndicator.querySelector(".pull-arrow").textContent = "⟳";
      await refreshSessions();
      toast("已重新整理");
      setTimeout(() => {
        el.pullIndicator.style.height = "0";
        el.pullIndicator.classList.remove("ready");
        el.pullIndicator.querySelector(".pull-arrow").textContent = "↓";
      }, 400);
    } else {
      el.pullIndicator.style.height = "0";
      el.pullIndicator.classList.remove("ready");
    }
  });
})();

// ---- 長按動作 sheet ----
let actionTarget = null;
function openSessionActions(s) {
  actionTarget = s;
  el.saTitle.textContent = stripMd(s.name || s.preview?.split("\n")[0] || "").slice(0, 60) || "(未命名)";
  el.saSheet.classList.remove("hidden");
}
function closeSessionActions() {
  el.saSheet.classList.add("hidden");
  actionTarget = null;
}
el.saCancel.addEventListener("click", closeSessionActions);
// Treat a tap/click on the dimmed backdrop as Cancel. This keeps the action
// sheet quick to dismiss on both touch and desktop without swallowing clicks
// on the actions inside the sheet.
el.saSheet.addEventListener("click", (event) => {
  if (event.target === el.saSheet) closeSessionActions();
});
el.saDelete.addEventListener("click", async () => {
  const target = actionTarget;
  closeSessionActions();
  if (!target) return;
  const isCurrent = currentSessionFile === target.file && !el.viewChat.classList.contains("hidden");
  try {
    await post("/api/delete", { file: target.file });
    if (isCurrent) { toast("已移到垃圾桶"); showList(); }
    else { toast("已移到垃圾桶"); refreshSessions(); }
  } catch (e) { toast("刪除失敗：" + e.message, true); }
});
el.saRename.addEventListener("click", () => {
  const target = actionTarget;
  closeSessionActions();
  el.renameInput.value = target?.name || "";
  el.renameDialog.classList.remove("hidden");
});
document.getElementById("rename-save").addEventListener("click", doRename);
el.renameCancel.addEventListener("click", () => el.renameDialog.classList.add("hidden"));
el.renameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doRename(); });
async function doRename() {
  const name = el.renameInput.value.trim();
  el.renameDialog.classList.add("hidden");
  if (!actionTarget || !name) return;
  try {
    await post("/api/rename", { file: actionTarget.file, name });
    toast("已重新命名");
    refreshSessions();
  } catch (e) { toast("重新命名失敗：" + e.message, true); }
}

// ---- Project folder actions (Codex-style group menu) ----
let projectActionTarget = null;

function projectActionText(key) {
  return window.piI18n?.t(key) || key;
}

function setProjectActionButton(button, icon, label) {
  if (!button) return;
  button.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#${icon}"></use></svg><span></span>`;
  button.querySelector("span").textContent = label;
  button.title = label;
}

function closeProjectActions() {
  el.projectActionSheet?.classList.add("hidden");
}

function openProjectActions(cwd, label) {
  projectActionTarget = { cwd: String(cwd || ""), label: String(label || projectDisplayName(cwd)) };
  if (!el.projectActionSheet) return;
  el.projectActionTitle.textContent = projectActionTarget.label;
  el.projectActionTitle.dataset.i18nIgnore = "true";
  setProjectActionButton(el.projectActionPin, projectIsPinned(cwd) ? "i-check" : "i-plus", projectActionText(projectIsPinned(cwd) ? "Unpin" : "Pin"));
  setProjectActionButton(el.projectActionEdit, "i-pencil", projectActionText("Edit project"));
  setProjectActionButton(el.projectActionReveal, "i-folder", projectActionText("Reveal in Finder"));
  setProjectActionButton(el.projectActionWorktree, "i-branch", projectActionText("Create permanent worktree"));
  setProjectActionButton(el.projectActionArchive, "i-archive", projectActionText("Archive chats"));
  setProjectActionButton(el.projectActionRemove, "i-x", projectActionText("Remove project"));
  if (el.projectActionCancel) el.projectActionCancel.textContent = projectActionText("Cancel");
  el.projectActionSheet.classList.remove("hidden");
}

function projectActionCwd() {
  return projectActionTarget?.cwd || "";
}

el.projectActionCancel?.addEventListener("click", closeProjectActions);
el.projectActionClose?.addEventListener("click", closeProjectActions);
el.projectActionSheet?.addEventListener("click", (event) => {
  if (event.target === el.projectActionSheet) closeProjectActions();
});
el.projectActionPin?.addEventListener("click", () => {
  const cwd = projectActionCwd();
  if (!cwd) return;
  const pins = new Set(settings.projectPins || []);
  if (pins.has(cwd)) pins.delete(cwd);
  else pins.add(cwd);
  saveProjectListSettings({ projectPins: [...pins] });
  closeProjectActions();
  toast(projectActionText(pins.has(cwd) ? "Project pinned" : "Project unpinned"));
});
el.projectActionEdit?.addEventListener("click", () => {
  const cwd = projectActionCwd();
  if (!cwd || !el.projectRenameDialog) return;
  closeProjectActions();
  el.projectRenameTitle.textContent = projectActionText("Edit project");
  el.projectRenameInput.value = settings.projectAliases?.[cwd] || projectDisplayName(cwd);
  el.projectRenameDialog.classList.remove("hidden");
  setTimeout(() => el.projectRenameInput.focus(), 0);
});
el.projectRenameCancel?.addEventListener("click", () => el.projectRenameDialog.classList.add("hidden"));
el.projectRenameInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") el.projectRenameSave.click();
  if (event.key === "Escape") el.projectRenameDialog.classList.add("hidden");
});
el.projectRenameSave?.addEventListener("click", () => {
  const cwd = projectActionCwd();
  if (!cwd) return;
  const alias = el.projectRenameInput.value.trim().replace(/[\r\n]+/g, " ").slice(0, 120);
  const aliases = { ...(settings.projectAliases || {}) };
  if (alias && alias !== projectFolderName(cwd)) aliases[cwd] = alias;
  else delete aliases[cwd];
  el.projectRenameDialog.classList.add("hidden");
  saveProjectListSettings({ projectAliases: aliases });
  toast(projectActionText("Project renamed"));
});
el.projectRenameDialog?.addEventListener("click", (event) => {
  if (event.target === el.projectRenameDialog) el.projectRenameDialog.classList.add("hidden");
});
el.projectActionReveal?.addEventListener("click", async () => {
  const cwd = projectActionCwd();
  closeProjectActions();
  if (!cwd) return;
  try {
    await post("/api/project-action", { action: "reveal", cwd });
    toast(projectActionText("Opened in Finder"));
  } catch (error) { toast(error.message || projectActionText("Could not reveal project"), true); }
});
el.projectActionWorktree?.addEventListener("click", async () => {
  const cwd = projectActionCwd();
  closeProjectActions();
  if (!cwd || !window.confirm(projectActionText("Create a permanent worktree for this project?"))) return;
  try {
    const result = await post("/api/project-action", { action: "worktree", cwd });
    toast(`${projectActionText("Permanent worktree created")}: ${result.path || ""}`);
    if (result.path) openNewDialog(result.path);
  } catch (error) { toast(error.message || projectActionText("Could not create worktree"), true); }
});
el.projectActionArchive?.addEventListener("click", async () => {
  const cwd = projectActionCwd();
  closeProjectActions();
  if (!cwd || !window.confirm(projectActionText("Archive this project's chats?"))) return;
  try {
    const result = await post("/api/project-action", { action: "archive", cwd });
    toast(`${projectActionText("Archived chats")}: ${result.count || 0}`);
    refreshSessions();
  } catch (error) { toast(error.message || projectActionText("Could not archive chats"), true); }
});
el.projectActionRemove?.addEventListener("click", () => {
  const cwd = projectActionCwd();
  closeProjectActions();
  if (!cwd || !window.confirm(projectActionText("Remove this project from the list? Chats remain on disk."))) return;
  const removed = new Set(settings.removedProjects || []);
  removed.add(cwd);
  saveProjectListSettings({ removedProjects: [...removed] });
  toast(projectActionText("Project removed"));
});

// ===========================================================================
// 對話視圖 + RPC
// ===========================================================================

function setChatTitle(title) {
  const value = String(title || "").trim();
  el.chatTitle.textContent = value || (window.piI18n?.t("New conversation") || "New conversation");
  el.chatTitle.toggleAttribute("data-i18n-ignore", !!value);
}

async function openExisting(s) {
  const generation = ++viewGeneration;
  if (rpc) closeChat(!!(rpc.streaming || rpc.connectionLost));
  currentSessionFile = s.file;
  renderSessionList(el.search.value);
  hideChatEmpty();
  setChatTitle(stripMd(s.name || s.preview?.split("\n")[0] || "") || "(未命名)");
  el.chatSub.dataset.base = s.cwd; el.chatSub.textContent = s.cwd; resetLiveUsage();
  removeHistoryLoadButton();
  historyState = { file: s.file, before: null, hasMore: false, loading: false };
  autoScrollPinned = true;
  el.messages.innerHTML = "";
  resetSessionUsage(s);
  ensureSessionUsageFooter();
  if (!isDesktop()) {
    el.viewList.classList.add("hidden");
    el.viewChat.classList.remove("hidden");
  } else {
    el.viewChat.classList.remove("hidden");
  }

  try {
    const detail = await api("/api/session?file=" + encodeURIComponent(s.file) + "&limit=300");
    if (generation !== viewGeneration) return;
    currentSessionCwd = detail.cwd;
    _lastMsgDate = null; lastUserText = "";
    for (const m of detail.messages || []) {
      maybeDateSeparator(m.ts || m.timestamp);
      appendHistoryMessage(m);
      if (m.role === "user") lastUserText = m.text || "";
    }
    mergeAdjacentWorkMessages();
    historyState.before = detail.nextBefore;
    historyState.hasMore = !!detail.hasMore;
    showHistoryLoadButton();
    scrollBottom(true);
  } catch (e) { console.warn("歷史讀取失敗", e); }
  await connectRpc({ file: s.file }, generation);
}

let currentSessionCwd = null;
let historyState = null;
let historyLoadButton = null;

function removeHistoryLoadButton() {
  if (historyLoadButton) historyLoadButton.remove();
  historyLoadButton = null;
}

function showHistoryLoadButton() {
  removeHistoryLoadButton();
  if (!historyState?.hasMore) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "history-load-button";
  button.textContent = "載入更早的訊息";
  button.addEventListener("click", () => loadOlderHistory(button));
  historyLoadButton = button;
  el.messages.prepend(button);
}

async function loadOlderHistory(button) {
  if (!historyState || historyState.loading || !historyState.hasMore) return;
  const state = historyState;
  const generation = viewGeneration;
  state.loading = true;
  button.disabled = true;
  button.textContent = "載入中…";
  const oldHeight = el.messages.scrollHeight;
  const oldTop = el.messages.scrollTop;
  try {
    const query = `?file=${encodeURIComponent(state.file)}&limit=300&before=${state.before}`;
    const detail = await api("/api/session" + query);
    if (generation !== viewGeneration || historyState !== state) return;
    const staging = document.createElement("div");
    for (const message of detail.messages || []) appendHistoryMessage(message, staging);
    const fragment = document.createDocumentFragment();
    while (staging.firstChild) fragment.appendChild(staging.firstChild);
    button.remove();
    historyLoadButton = null;
    el.messages.prepend(fragment);
    mergeAdjacentWorkMessages();
    state.before = detail.nextBefore;
    state.hasMore = !!detail.hasMore;
    showHistoryLoadButton();
    el.messages.scrollTop = el.messages.scrollHeight - oldHeight + oldTop;
    updateScrollBottomButton();
  } catch (error) {
    button.disabled = false;
    button.textContent = "載入更早的訊息";
    toast("載入歷史失敗：" + error.message, true);
  } finally {
    if (historyState === state) state.loading = false;
  }
}

async function startNew(cwd, name) {
  const generation = ++viewGeneration;
  if (rpc) closeChat(!!(rpc.streaming || rpc.connectionLost));
  currentSessionFile = null;
  _lastMsgDate = null;
  lastUserText = "";
  currentSessionCwd = cwd;
  historyState = null;
  removeHistoryLoadButton();
  autoScrollPinned = true;
  hideChatEmpty();
  setChatTitle(name);
  el.chatSub.dataset.base = cwd; el.chatSub.textContent = cwd; resetLiveUsage();
  el.messages.innerHTML = "";
  resetSessionUsage();
  ensureSessionUsageFooter();
  if (!isDesktop()) {
    el.viewList.classList.add("hidden");
    el.viewChat.classList.remove("hidden");
  } else {
    el.viewChat.classList.remove("hidden");
  }
  await connectRpc({ cwd, name }, generation);
}

async function connectRpc(opts, generation = viewGeneration) {
  const baseAtStart = apiBase;
  setStreaming(false);
  try {
    const r = await post("/api/open", opts);
    if (generation !== viewGeneration || baseAtStart !== apiBase) {
      if (!r.reused) fetch(baseAtStart + "/api/close", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sid: r.sid }),
      }).catch(() => {});
      return;
    }
    const sid = r.sid;
    const replayAfter = Number.isFinite(Number(r.replayAfter)) ? Number(r.replayAfter) : -1;
    rpc = {
      sid, es: null, streaming: !!r.isStreaming, connectionLost: false,
      streamEnded: false, streamReady: false, readyTimer: null,
      reconnectTimer: null, reconnectAttempt: 0,
      lastEventId: replayAfter, activityLabel: "thinking", lastEventAt: Date.now(),
    };
    setStreaming(!!r.isStreaming);
    let esFail = 0;

    const scheduleReconnect = (es, reason = "error") => {
      if (!rpc || rpc.sid !== sid || rpc.streamEnded) return;
      if (rpc.readyTimer) clearTimeout(rpc.readyTimer);
      rpc.readyTimer = null;
      rpc.streamReady = false;
      try { es?.close(); } catch {}
      if (rpc.es === es) rpc.es = null;
      rpc.connectionLost = true;
      const attempt = ++rpc.reconnectAttempt;
      const delay = Math.min(30_000, 800 * (2 ** Math.min(attempt - 1, 5)));
      el.queueNote.dataset.connection = "lost";
      el.queueNote.textContent = rpc.streaming
        ? `即時連線中斷，${Math.ceil(delay / 1000)} 秒後自動恢復…`
        : (reason === "ready_timeout" ? "即時連線沒有回應，正在恢復…" : "正在恢復即時連線…");
      el.queueNote.classList.remove("hidden");
      if (rpc.reconnectTimer) return;
      rpc.reconnectTimer = setTimeout(() => {
        if (!rpc || rpc.sid !== sid || rpc.streamEnded) return;
        rpc.reconnectTimer = null;
        openStream(Math.max(-1, Number(rpc.lastEventId) || -1));
      }, delay);
    };

    const openStream = (after) => {
      if (!rpc || rpc.sid !== sid || rpc.streamEnded) return;
      const es = new EventSource(baseAtStart + "/api/stream?sid=" + encodeURIComponent(sid) + "&after=" + encodeURIComponent(after));
      rpc.es = es;
      rpc.streamReady = false;
      if (rpc.readyTimer) clearTimeout(rpc.readyTimer);
      rpc.readyTimer = setTimeout(() => {
        if (rpc?.sid === sid && rpc.es === es && !rpc.streamReady && !rpc.streamEnded) {
          scheduleReconnect(es, "ready_timeout");
        }
      }, 12_000);
      const markStreamReady = (snapshot = null) => {
        if (!rpc || rpc.sid !== sid || rpc.streamEnded) return;
        rpc.streamReady = true;
        if (rpc.readyTimer) clearTimeout(rpc.readyTimer);
        rpc.readyTimer = null;
        esFail = 0;
        rpc.connectionLost = false;
        rpc.reconnectAttempt = 0;
        rpc.lastEventAt = Date.now();
        if (snapshot && typeof snapshot.isStreaming === "boolean" && snapshot.isStreaming !== rpc.streaming) {
          setStreaming(snapshot.isStreaming);
        }
        if (el.queueNote.dataset.connection === "lost") {
          delete el.queueNote.dataset.connection;
          if (!rpc.streaming) el.queueNote.classList.add("hidden");
          else el.queueNote.textContent = "連線已恢復，工作仍在繼續…";
        }
      };
      es.onopen = () => {
        if (rpc?.sid !== sid) { try { es.close(); } catch {} return; }
        // onopen is the transport-level fallback for older Pi Harbor peers;
        // current peers also send the named `connected` readiness handshake
        // below with a state snapshot.
        markStreamReady();
      };
      es.addEventListener("connected", (event) => {
        let snapshot = null;
        try { snapshot = JSON.parse(event.data); } catch {}
        markStreamReady(snapshot);
      });
      es.onmessage = (event) => {
        if (rpc?.sid !== sid) { try { es.close(); } catch {} return; }
        esFail = 0;
        const eventId = Number(event.lastEventId);
        if (Number.isFinite(eventId)) rpc.lastEventId = Math.max(rpc.lastEventId, eventId);
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        handleRpcEvent(data, sid);
      };
      es.onerror = () => {
        if (rpc?.sid !== sid) { try { es.close(); } catch {} return; }
        if (rpc.streamEnded) return;
        esFail++;
        // EventSource will briefly retry by itself. After a few failures we
        // take over so the next request explicitly resumes after lastEventId.
        if (esFail < 3) return;
        scheduleReconnect(es);
      };
    };
    openStream(replayAfter);
  } catch (e) {
    if (generation !== viewGeneration) return;
    toast("無法開啟對話：" + e.message, true);
    showList();
    return;
  }
  refreshCommands(rpc?.sid);
  syncComposerState(rpc?.sid);
}

function closeChat(silent) {
  if (rpc) {
    rpc.streamEnded = true;
    if (rpc.reconnectTimer) clearTimeout(rpc.reconnectTimer);
    if (rpc.readyTimer) clearTimeout(rpc.readyTimer);
    rpc.reconnectTimer = null;
    rpc.readyTimer = null;
    try { rpc.es && rpc.es.close(); } catch {}
    if (!silent) post("/api/close", { sid: rpc.sid }).catch(() => {});
    rpc = null;
  }
  delete el.queueNote.dataset.connection;
  pendingAssistant = null;
  liveToolCards = new Map();
  liveActivity = null;
  historyState = null;
  removeHistoryLoadButton();
  pendingImages = [];
  renderImgPreview();
  setStreaming(false);
}

// ---- 訊息渲染 ----
function messageDistanceFromBottom() {
  return el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight;
}
function updateScrollBottomButton() {
  if (!el.scrollBottomBtn) return;
  const distance = messageDistanceFromBottom();
  el.scrollBottomBtn.classList.toggle("hidden", distance < 180 || el.messages.scrollHeight <= el.messages.clientHeight + 40);
}
function scrollBottom(force = false) {
  if (!force && !autoScrollPinned) {
    updateScrollBottomButton();
    return;
  }
  if (scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = null;
    el.messages.scrollTop = el.messages.scrollHeight;
    autoScrollPinned = true;
    updateScrollBottomButton();
  });
}
function resetSessionUsage(seed = null) {
  const tokens = Number(seed?.tokens);
  const cost = Number(seed?.cost);
  sessionUsage = {
    tokens: Number.isFinite(tokens) && tokens > 0 ? tokens : 0,
    cost: Number.isFinite(cost) && cost > 0 ? cost : 0,
  };
  sessionUsageFooter = null;
}
function keepSessionUsageAtEnd() {
  if (sessionUsageFooter?.parentElement === el.messages) el.messages.appendChild(sessionUsageFooter);
}
function updateSessionUsageFooter() {
  if (!sessionUsageFooter) return;
  const parts = [];
  if (sessionUsage.tokens > 0) parts.push(`${fmtTokens(sessionUsage.tokens)} tok`);
  if (sessionUsage.cost > 0) parts.push(`$${sessionUsage.cost.toFixed(4)}`);
  sessionUsageFooter.textContent = parts.join(" · ");
  sessionUsageFooter.classList.toggle("hidden", parts.length === 0);
}
function ensureSessionUsageFooter() {
  if (!el.messages) return null;
  if (!sessionUsageFooter || sessionUsageFooter.parentElement !== el.messages) {
    sessionUsageFooter = document.createElement("div");
    sessionUsageFooter.className = "session-usage hidden";
    sessionUsageFooter.setAttribute("aria-label", "本次對話用量");
    el.messages.appendChild(sessionUsageFooter);
  }
  updateSessionUsageFooter();
  keepSessionUsageAtEnd();
  return sessionUsageFooter;
}
function addSessionUsage(u) {
  if (!u) return;
  const tokens = Number(u.tokens);
  const cost = Number(u.cost);
  if (Number.isFinite(tokens) && tokens > 0) sessionUsage.tokens += tokens;
  if (Number.isFinite(cost) && cost > 0) sessionUsage.cost += cost;
  ensureSessionUsageFooter();
}
el.messages.addEventListener("scroll", () => {
  const distance = messageDistanceFromBottom();
  if (distance < 80) autoScrollPinned = true;
  else if (!scrollFrame) autoScrollPinned = false;
  updateScrollBottomButton();
}, { passive: true });
el.scrollBottomBtn?.addEventListener("click", () => {
  autoScrollPinned = true;
  el.messages.scrollTo({ top: el.messages.scrollHeight, behavior: settings.reducedMotion ? "auto" : "smooth" });
});
function makeMsgShell(role, tagText, container = el.messages) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + role + " msg-in";
  const tag = document.createElement("div");
  tag.className = "role-tag";
  tag.textContent = tagText;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  wrap.appendChild(tag);
  wrap.appendChild(bubble);
  container.appendChild(wrap);
  if (container === el.messages) keepSessionUsageAtEnd();
  return { wrap, bubble };
}

const SAFE_IMAGE_DATA_URL = /^data:image\/(?:jpeg|png|webp|gif);base64,[a-z0-9+/]+={0,2}$/i;
const MAX_DISPLAY_IMAGE_DATA_LENGTH = 8 * 1024 * 1024;
let imageLightboxTrigger = null;

function normalizeImageAttachment(image) {
  const source = image && typeof image === "object" && image.source && typeof image.source === "object" ? image.source : null;
  let raw = typeof image === "string" ? image : image?.data;
  if (!raw && source) raw = source.data;
  let src = String(raw || "").replace(/\s+/g, "");
  if (!src.startsWith("data:")) {
    const mimeType = String(image?.mimeType || image?.mediaType || source?.mimeType || source?.media_type || "image/jpeg").toLowerCase();
    if (/^image\/(?:jpeg|png|webp|gif)$/i.test(mimeType) && /^[a-z0-9+/]+={0,2}$/i.test(src)) {
      src = `data:${mimeType};base64,${src}`;
    }
  }
  if (!src || src.length > MAX_DISPLAY_IMAGE_DATA_LENGTH || !SAFE_IMAGE_DATA_URL.test(src)) return null;
  return { src, mimeType: typeof image?.mimeType === "string" ? image.mimeType : "" };
}

function closeImageLightbox() {
  if (!el.imageLightbox) return;
  el.imageLightbox.classList.add("hidden");
  document.body.classList.remove("image-lightbox-open");
  if (el.imageLightboxImg) el.imageLightboxImg.removeAttribute("src");
  const trigger = imageLightboxTrigger;
  imageLightboxTrigger = null;
  if (trigger && typeof trigger.focus === "function") trigger.focus({ preventScroll: true });
}

function openImageLightbox(image, alt = "圖片", trigger = null) {
  const item = normalizeImageAttachment(image);
  if (!item || !el.imageLightbox || !el.imageLightboxImg) return;
  imageLightboxTrigger = trigger;
  el.imageLightboxImg.src = item.src;
  el.imageLightboxImg.alt = alt;
  if (el.imageLightboxCaption) el.imageLightboxCaption.textContent = alt;
  el.imageLightbox.classList.remove("hidden");
  document.body.classList.add("image-lightbox-open");
  el.imageLightboxClose?.focus({ preventScroll: true });
}

function appendImageGallery(target, attachments, expectedCount = 0) {
  if (!target || !Array.isArray(attachments)) return 0;
  const images = attachments.map(normalizeImageAttachment).filter(Boolean);
  if (!images.length) return 0;
  const gallery = document.createElement("div");
  gallery.className = "msg-thumbs";
  images.forEach((image, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "msg-image-button";
    button.title = "點擊放大圖片";
    button.setAttribute("aria-label", `查看圖片 ${index + 1}`);
    const img = document.createElement("img");
    img.src = image.src;
    img.alt = `圖片 ${index + 1}`;
    img.loading = "lazy";
    img.decoding = "async";
    button.appendChild(img);
    button.addEventListener("click", () => openImageLightbox(image, img.alt, button));
    gallery.appendChild(button);
  });
  const omitted = Math.max(0, Number(expectedCount) - images.length);
  if (omitted) {
    const note = document.createElement("span");
    note.className = "msg-image-note";
    note.textContent = `另有 ${omitted} 張圖片無法預覽`;
    gallery.appendChild(note);
  }
  target.appendChild(gallery);
  return images.length;
}

el.imageLightboxClose?.addEventListener("click", closeImageLightbox);
el.imageLightbox?.addEventListener("click", (event) => {
  if (event.target === el.imageLightbox || event.target === el.imageLightbox.querySelector(".image-lightbox-stage")) closeImageLightbox();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && el.imageLightbox && !el.imageLightbox.classList.contains("hidden")) closeImageLightbox();
});

function makeThinking(text) {
  const box = document.createElement("div");
  box.className = "thinking-wrap";
  const toggle = document.createElement("button");
  toggle.className = "thinking-toggle";
  toggle.textContent = "thinking";
  const pre = document.createElement("div");
  // 長思考永遠先收合；即使使用者偏好展開，也要點擊後才佔滿畫面。
  const autoOpen = settings.thinking === "open" && text.length > 0 && text.length < 800;
  pre.className = "thinking-block" + (autoOpen ? " open" : "");
  pre.textContent = text;
  box.classList.toggle("open", autoOpen);
  toggle.setAttribute("aria-expanded", String(autoOpen));
  toggle.addEventListener("click", () => {
    const open = pre.classList.toggle("open");
    box.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", String(open));
  });
  box.appendChild(toggle);
  box.appendChild(pre);
  return box;
}
function toolKey(name) {
  return String(name || "tool").toLowerCase().replace(/[^a-z0-9_-]/g, "");
}
function toolTarget(args) {
  const raw = typeof args === "string" ? args : summarizeArgs(args);
  return String(raw || "").replace(/^['\"]|['\"]$/g, "").trim();
}
function toolTargetShort(args) {
  const target = toolTarget(args);
  if (!target || target.includes(" ")) return target;
  return target.split(/[\\/]/).filter(Boolean).pop() || target;
}
function toolTitle(name, args, running) {
  const key = toolKey(name);
  const target = toolTarget(args);
  const short = toolTargetShort(args);
  if (key.includes("bash") || key.includes("shell") || key.includes("terminal") || key === "exec") {
    return `${running ? "Running " : ""}bash${target ? " " + target : ""}`;
  }
  if (key.includes("read") || key.includes("cat") || key.includes("glob")) return `${running ? "Reading " : "Read "}${short || "file"}`;
  if (key.includes("write") || key.includes("edit") || key.includes("patch")) return `${running ? "Writing " : "Edit "}${short || "file"}`;
  if (key.includes("search") || key.includes("grep") || key.includes("find")) return `${running ? "Searching " : "Search "}${target || "files"}`;
  return `${running ? "Running " : ""}${String(name || "tool")}${target ? " " + target : ""}`;
}
function isEditTool(name) {
  const key = toolKey(name);
  return key.includes("write") || key.includes("edit") || key.includes("patch");
}
function activityCards(activity) {
  return activity
    ? [...activity.body.children].filter((child) => child.classList.contains("tool-card"))
    : [];
}
function activityFileTarget(args) {
  const raw = toolTarget(args);
  if (!raw) return "";
  if (!/\s/.test(raw)) return raw;
  const candidate = raw.split(/\s+/).find((part) => /[\\/]/.test(part) || /\.(?:css|html?|js|json|md|py|sh|ts|tsx|yaml|yml)$/i.test(part));
  return candidate || raw.slice(0, 80);
}
function activitySummary(activity) {
  const cards = activityCards(activity);
  const editCalls = cards.filter((card) => isEditTool(card.__tool?.name));
  const files = new Set(editCalls.map((card) => activityFileTarget(card.__tool?.args)).filter(Boolean));
  if (cards.length === 1 && editCalls.length === 1) {
    return `Edited ${activityFileTarget(editCalls[0].__tool?.args) || "file"}`;
  }
  if (editCalls.length) {
    const fileCount = files.size || editCalls.length;
    const fileWord = fileCount === 1 ? "file" : "files";
    const toolWord = cards.length === 1 ? "tool" : "tools";
    return `Edited ${fileCount} ${fileWord} and called ${cards.length} ${toolWord}`;
  }
  if (cards.length === 1) {
    const meta = cards[0].__tool || {};
    const key = toolKey(meta.name);
    if (key.includes("bash") || key.includes("shell") || key.includes("terminal") || key === "exec") return "Ran bash";
    if (key.includes("read") || key.includes("cat") || key.includes("glob")) return `Read ${toolTargetShort(meta.args) || "file"}`;
    if (key.includes("search") || key.includes("grep") || key.includes("find")) return "Searched files";
    return toolTitle(meta.name, meta.args, false);
  }
  if (cards.length) return `Called ${cards.length} tools`;
  return activity.latest || "Thinking";
}
function makeActivityGroup({ running = false, count = 0, latest = "" } = {}) {
  const details = document.createElement("details");
  details.className = "activity-group" + (running ? " running" : "");
  const summary = document.createElement("summary");
  summary.className = "activity-summary";
  const icon = document.createElement("span");
  icon.className = "activity-icon";
  icon.setAttribute("aria-hidden", "true");
  const info = document.createElement("span");
  info.className = "activity-info";
  const title = document.createElement("span");
  title.className = "activity-title";
  const detail = document.createElement("span");
  detail.className = "activity-detail";
  info.append(title, detail);
  const chevron = document.createElement("span");
  chevron.className = "activity-chevron";
  chevron.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-chevron-right"></use></svg>';
  summary.append(icon, info, chevron);
  const body = document.createElement("div");
  body.className = "activity-body";
  details.append(summary, body);
  const activity = {
    details, body, title, detail, icon,
    count: Math.max(0, Number(count) || 0),
    latest: String(latest || ""),
    running: !!running,
    hasError: false,
  };
  details.__activity = activity;
  updateActivityGroup(activity);
  return activity;
}
function updateActivityGroup(activity, patch = {}) {
  if (!activity) return;
  if (Object.prototype.hasOwnProperty.call(patch, "running")) activity.running = !!patch.running;
  if (Object.prototype.hasOwnProperty.call(patch, "count")) activity.count = Math.max(0, Number(patch.count) || 0);
  if (Object.prototype.hasOwnProperty.call(patch, "latest")) activity.latest = String(patch.latest || "");
  if (Object.prototype.hasOwnProperty.call(patch, "hasError")) activity.hasError = !!patch.hasError;
  activity.details.classList.toggle("running", activity.running);
  activity.details.classList.toggle("has-error", activity.hasError);
  const cards = activityCards(activity);
  activity.count = cards.length || activity.count;
  activity.details.dataset.steps = String(activity.count);
  const representative = cards.find((card) => card.classList.contains("running")) || cards[0];
  const iconHref = representative ? toolIcon(representative.__tool?.name) : "";
  activity.icon.innerHTML = iconHref
    ? `<svg class="icon" aria-hidden="true"><use href="${iconHref}"></use></svg>`
    : "";
  activity.icon.classList.toggle("empty", !iconHref);
  activity.title.textContent = activity.running
    ? (activity.latest || "Working…")
    : activitySummary(activity);
  activity.title.title = activity.title.textContent;
  activity.detail.textContent = activity.running
    ? (activity.count ? `${activity.count} ${activity.count === 1 ? "tool" : "tools"}` : "thinking…")
    : "";
  activity.details.setAttribute("aria-label", activity.detail.textContent
    ? `${activity.title.textContent}：${activity.detail.textContent}`
    : activity.title.textContent);
}
function toolIcon(name) {
  const key = toolKey(name);
  if (key.includes("read") || key.includes("cat")) return "#i-book";
  if (key.includes("write") || key.includes("edit") || key.includes("patch")) return "#i-pencil";
  return "#i-terminal";
}
function toolOutputLabel(name) {
  const key = toolKey(name);
  if (key.includes("bash") || key.includes("shell") || key.includes("terminal") || key === "exec") return "Shell";
  if (key.includes("read") || key.includes("cat")) return "Output";
  return "Result";
}
function makeToolCard(name, args, resultText, isError, running) {
  const details = document.createElement("details");
  details.className = "tool-card" + (isError ? " err" : "") + (running ? " running" : "");
  details.__tool = { name, args };
  const summary = document.createElement("summary");
  summary.className = "tool-head";
  const iconBox = document.createElement("span");
  iconBox.className = "tool-ico";
  iconBox.innerHTML = `<svg class="icon" aria-hidden="true"><use href="${toolIcon(name)}"></use></svg>`;
  const info = document.createElement("span");
  info.className = "tool-info";
  const title = document.createElement("span");
  title.className = "tool-name";
  title.textContent = toolTitle(name, args, running);
  title.title = toolTitle(name, args, false);
  info.append(title);
  const chevron = document.createElement("span");
  chevron.className = "tool-chevron";
  chevron.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-chevron-right"></use></svg>';
  summary.append(iconBox, info, chevron);
  const body = document.createElement("div");
  body.className = "tool-body";
  const command = document.createElement("div");
  command.className = "tool-command";
  command.textContent = toolTitle(name, args, false);
  const label = document.createElement("div");
  label.className = "tool-output-label";
  label.textContent = toolOutputLabel(name);
  const output = document.createElement("pre");
  output.className = "tool-output";
  output.textContent = resultText || "（執行中…）";
  body.append(command, label, output);
  details.append(summary, body);
  return details;
}
function ensureActivityGroup({ bubble = null, running = true } = {}) {
  if (pendingAssistant?.activity) {
    liveActivity = pendingAssistant.activity;
    updateActivityGroup(liveActivity, { running: running || liveActivity.running });
    return liveActivity;
  }
  if (liveActivity && (!bubble || liveActivity.details.parentElement === bubble)) {
    updateActivityGroup(liveActivity, { running: running || liveActivity.running });
    return liveActivity;
  }
  let target = bubble;
  if (!target) {
    const assistants = el.messages.querySelectorAll(".msg.assistant .bubble");
    target = assistants[assistants.length - 1] || null;
  }
  if (!target) {
    ensurePendingAssistant();
    target = pendingAssistant?.bubble || null;
  }
  if (!target) return null;
  const activity = makeActivityGroup({ running });
  if (pendingAssistant) pendingAssistant.activity = activity;
  if (pendingAssistant?.textEl?.parentNode === target) target.insertBefore(activity.details, pendingAssistant.textEl);
  else target.appendChild(activity.details);
  liveActivity = activity;
  return activity;
}
function setToolCardState(card, { running = false, isError = false, text = null } = {}) {
  if (!card) return;
  const meta = card.__tool || {};
  const title = card.querySelector(".tool-name");
  const sub = card.querySelector(".tool-sub");
  const status = card.querySelector(".tool-status");
  const output = card.querySelector(".tool-output");
  const command = card.querySelector(".tool-command");
  card.classList.toggle("running", running);
  card.classList.toggle("err", !!isError);
  if (title) title.textContent = toolTitle(meta.name, meta.args, running);
  if (title) title.title = toolTitle(meta.name, meta.args, false);
  if (command) command.textContent = toolTitle(meta.name, meta.args, false);
  if (sub) sub.textContent = running ? "working…" : "";
  if (status) {
    status.classList.remove("running", "error", "done");
    status.classList.add(running ? "running" : (isError ? "error" : "done"));
    status.setAttribute("aria-label", running ? "working" : (isError ? "error" : "success"));
  }
  if (text !== null && output) output.textContent = text || (isError ? "（沒有收到工具輸出）" : "（無輸出）");
  const activity = card.closest(".activity-group")?.__activity;
  if (activity) {
    const cards = [...activity.body.children].filter((child) => child.classList.contains("tool-card"));
    updateActivityGroup(activity, {
      running: cards.some((item) => item.classList.contains("running")),
      count: cards.length,
      hasError: cards.some((item) => item.classList.contains("err")),
    });
  }
}
function appendLiveToolCard(toolCallId, name, args) {
  let card = toolCallId ? liveToolCards.get(toolCallId) : null;
  if (card) return card;
  let bubble = pendingAssistant?.bubble;
  if (!bubble) {
    const assistants = el.messages.querySelectorAll(".msg.assistant .bubble");
    bubble = assistants[assistants.length - 1] || null;
  }
  if (!bubble) {
    ensurePendingAssistant();
    bubble = pendingAssistant.bubble;
  }
  const activity = ensureActivityGroup({ bubble, running: true });
  if (!activity) return null;
  card = makeToolCard(name, args, null, false, true);
  card.dataset.toolCallId = toolCallId || "";
  activity.body.appendChild(card);
  updateActivityGroup(activity, {
    running: true,
    count: [...activity.body.children].filter((child) => child.classList.contains("tool-card")).length,
    latest: toolTitle(name, args, true),
  });
  if (toolCallId) liveToolCards.set(toolCallId, card);
  return card;
}
function summarizeArgs(args) {
  if (!args || typeof args !== "object") return "";
  return args.command || args.path || args.file_path || args.pattern || args.query ||
         Object.values(args).find(v => typeof v === "string")?.slice(0, 120) || "";
}
function appendHistoryMessage(m, container = el.messages) {
  if (m.role === "user") {
    const { bubble } = makeMsgShell("user", "你", container);
    if (m.text) bubble.appendChild(renderMarkdown(m.text));
    const rendered = appendImageGallery(bubble, m.imageAttachments, m.images || 0);
    if (!m.text && !rendered && m.images) {
      const note = document.createElement("span");
      note.className = "image-message-fallback";
      note.textContent = `[${m.images} 張圖片]`;
      bubble.appendChild(note);
    }
  } else if (m.role === "assistant") {
    const { wrap, bubble } = makeMsgShell("assistant", m.model ? `pi · ${m.model}` : "pi", container);
    const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
    let activity = null;
    if (m.thinking || calls.length) {
      activity = makeActivityGroup({ running: false, count: calls.length });
      bubble.appendChild(activity.details);
      if (m.thinking) activity.body.appendChild(makeThinking(m.thinking));
      for (const tc of calls) {
        activity.body.appendChild(makeToolCard(tc.name, tc.args, null));
        activity.latest = toolTitle(tc.name, tc.args, false);
      }
      updateActivityGroup(activity, { running: false, count: calls.length, latest: activity.latest });
    }
    if (m.text) bubble.appendChild(renderMarkdown(m.text));
    if (isFailureMessage(m)) {
      if (activity) updateActivityGroup(activity, { running: false, hasError: true });
      appendRunError(bubble, m);
    }
    wrap.appendChild(msgActionsRow("assistant", () => m.text || m.errorMessage || ""));
    if (m.usage) attachMessageUsage(wrap, m.usage, activity);
  } else if (m.role === "toolResult") {
    attachToolResult(m.toolName, m.isError, m.text, container);
  }
  if (container === el.messages) {
    keepSessionUsageAtEnd();
    scrollBottom();
  }
}
function usageTag(u) {
  const d = document.createElement("div");
  d.className = "usage-tag";
  d.textContent = `${fmtTokens(u.tokens)} tok` + (u.cost != null ? ` · $${Number(u.cost).toFixed(4)}` : "");
  return d;
}
function attachMessageUsage(wrap, usage, activity = null) {
  const node = usageTag(usage);
  node.classList.add("message-usage");
  if (activity?.body) {
    node.classList.add("activity-usage");
    activity.body.appendChild(node);
    return node;
  }
  wrap.appendChild(node);
  bindMessageUsage(node, activity);
  return node;
}
function bindMessageUsage(node, activity = null) {
  if (!node) return;
  const previous = node.__usageActivity;
  if (previous?.details && node.__usageSync) previous.details.removeEventListener("toggle", node.__usageSync);
  node.__usageActivity = activity || null;
  node.__usageSync = null;
  if (!activity?.details) {
    node.classList.remove("revealed");
    return;
  }
  const sync = () => node.classList.toggle("revealed", !!activity.details.open);
  node.__usageSync = sync;
  activity.details.addEventListener("toggle", sync);
  sync();
}
function directMessageBubble(wrap) {
  return [...(wrap?.children || [])].find((child) => child.classList.contains("bubble")) || null;
}
function directActivityDetails(bubble) {
  return [...(bubble?.children || [])].find((child) => child.classList.contains("activity-group")) || null;
}
function mergeAssistantPair(target, source) {
  const targetBubble = directMessageBubble(target);
  const sourceBubble = directMessageBubble(source);
  if (!targetBubble || !sourceBubble) return false;
  const targetDetails = directActivityDetails(targetBubble);
  const sourceDetails = directActivityDetails(sourceBubble);
  let targetActivity = targetDetails?.__activity || null;
  const sourceActivity = sourceDetails?.__activity || null;

  if (sourceActivity) {
    if (targetActivity) {
      for (const child of [...sourceActivity.body.children]) targetActivity.body.appendChild(child);
      updateActivityGroup(targetActivity, {
        running: targetActivity.running || sourceActivity.running,
        latest: sourceActivity.latest || targetActivity.latest,
        count: activityCards(targetActivity).length,
        hasError: targetActivity.hasError || sourceActivity.hasError,
      });
      if (sourceDetails.open) targetDetails.open = true;
      sourceDetails.remove();
    } else {
      targetBubble.appendChild(sourceDetails);
      targetDetails && (targetActivity = sourceActivity);
    }
  }

  for (const child of [...sourceBubble.childNodes]) {
    if (child === sourceDetails) continue;
    targetBubble.appendChild(child);
  }

  // Keep one copy/retry row for the whole work group; usage rows remain
  // available when the consolidated activity group is opened.
  for (const child of [...source.children]) {
    if (child.classList.contains("msg-actions")) {
      child.remove();
      continue;
    }
    if (child.classList.contains("message-usage")) {
      target.appendChild(child);
      bindMessageUsage(child, targetActivity);
    }
  }
  if (liveActivity && sourceDetails && liveActivity.details === sourceDetails) liveActivity = targetActivity;
  if (pendingAssistant?.wrap === source) {
    pendingAssistant.wrap = target;
    pendingAssistant.bubble = targetBubble;
    pendingAssistant.activity = targetActivity;
  }
  source.remove();
  return true;
}
function mergeAdjacentWorkMessages(container = el.messages) {
  if (!container) return;
  let changed = true;
  while (changed) {
    changed = false;
    const children = [...container.children];
    for (let i = 1; i < children.length; i++) {
      const target = children[i - 1];
      const source = children[i];
      if (!target.classList.contains("msg") || !source.classList.contains("msg") ||
          !target.classList.contains("assistant") || !source.classList.contains("assistant")) continue;
      if (!mergeAssistantPair(target, source)) continue;
      changed = true;
      break;
    }
  }
}
function attachToolResult(toolName, isError, text, container = el.messages) {
  const cards = container.querySelectorAll(".tool-card");
  for (let i = cards.length - 1; i >= 0; i--) {
    const body = cards[i].querySelector(".tool-output");
    if (body && body.textContent === "（執行中…）") {
      setToolCardState(cards[i], { running: false, isError: !!isError, text });
      return;
    }
  }
}

function finishExtensionUi(response) {
  const request = extensionUiRequest;
  if (!request) return;
  extensionUiRequest = null;
  el.extensionUiSheet.classList.add("hidden");
  el.extensionUiInput.type = "text";
  if (request.kind === "provider-auth") {
    providerAuthRequest = null;
    el.extensionUiInput.value = "";
    post("/api/provider-auth/respond", { runId: request.runId, requestId: request.id, ...response })
      .catch((e) => toast("回覆 Provider 登入失敗：" + e.message, true));
    return;
  }
  post("/api/rpc-ui", { sid: request.sid, id: request.id, ...response })
    .catch((e) => toast("回覆 Pi 失敗：" + e.message, true));
}

function showExtensionUi(ev, sid) {
  const method = ev.method;
  if (method === "notify") {
    toast(ev.message || "Pi 通知", ev.notifyType === "error");
    return;
  }
  if (method === "setStatus") {
    el.queueNote.textContent = ev.statusText || "";
    el.queueNote.classList.toggle("hidden", !ev.statusText);
    return;
  }
  if (method === "setWidget") {
    const lines = Array.isArray(ev.widgetLines) ? ev.widgetLines.join("\n") : "";
    if (lines) toast(lines.slice(0, 220));
    return;
  }
  if (!["select", "confirm", "input", "editor"].includes(method)) {
    post("/api/rpc-ui", { sid, id: ev.id, cancelled: true }).catch(() => {});
    return;
  }

  extensionUiRequest = { sid, id: ev.id, method };
  el.extensionUiKind.textContent = method.toUpperCase();
  el.extensionUiTitle.textContent = ev.title || "需要你的回覆";
  el.extensionUiMessage.textContent = ev.message || "";
  el.extensionUiOptions.innerHTML = "";
  el.extensionUiInput.classList.add("hidden");
  el.extensionUiInput.type = "text";
  el.extensionUiEditor.classList.add("hidden");
  el.extensionUiSubmit.classList.add("hidden");

  if (method === "select") {
    for (const option of Array.isArray(ev.options) ? ev.options : []) {
      const value = typeof option === "string" ? option : (option?.value ?? option?.label ?? "");
      const label = typeof option === "string" ? option : (option?.label ?? value);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "action-row extension-ui-option";
      button.textContent = label;
      button.addEventListener("click", () => finishExtensionUi({ value }));
      el.extensionUiOptions.appendChild(button);
    }
  } else if (method === "confirm") {
    el.extensionUiSubmit.textContent = "確認";
    el.extensionUiSubmit.classList.remove("hidden");
    el.extensionUiSubmit.onclick = () => finishExtensionUi({ confirmed: true });
  } else if (method === "input") {
    el.extensionUiInput.placeholder = ev.placeholder || "輸入內容";
    el.extensionUiInput.value = ev.prefill || "";
    el.extensionUiInput.classList.remove("hidden");
    el.extensionUiSubmit.textContent = "送出";
    el.extensionUiSubmit.classList.remove("hidden");
    el.extensionUiSubmit.onclick = () => finishExtensionUi({ value: el.extensionUiInput.value });
  } else if (method === "editor") {
    el.extensionUiEditor.value = ev.prefill || "";
    el.extensionUiEditor.classList.remove("hidden");
    el.extensionUiSubmit.textContent = "完成";
    el.extensionUiSubmit.classList.remove("hidden");
    el.extensionUiSubmit.onclick = () => finishExtensionUi({ value: el.extensionUiEditor.value });
  }
  el.extensionUiSheet.classList.remove("hidden");
  if (method === "input") el.extensionUiInput.focus();
  if (method === "editor") el.extensionUiEditor.focus();
}
el.extensionUiCancel.addEventListener("click", () => {
  if (extensionUiRequest) finishExtensionUi({ cancelled: true });
  else if (providerAuthRun) void cancelProviderAuth();
});

// ---- RPC 事件 ----
function activityAgeText(ms) {
  const seconds = Math.max(1, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分鐘`;
}
function clearActivityNote() {
  el.queueNote.classList.remove("stale");
  delete el.queueNote.dataset.persistent;
}
function updateActivityWatchdog() {
  if (!rpc?.streaming || !rpc.lastEventAt) return;
  const idle = Date.now() - rpc.lastEventAt;
  if (idle < ACTIVITY_STALE_MS) return;
  el.queueNote.dataset.persistent = "stale";
  el.queueNote.textContent = `仍在${rpc.activityLabel || "工作"}…最後更新於 ${activityAgeText(idle)}前；若沒有繼續，可按停止後重試。`;
  el.queueNote.classList.add("stale");
  el.queueNote.classList.remove("hidden");
}
function markRpcActivity() {
  if (rpc) rpc.lastEventAt = Date.now();
  if (el.queueNote.classList.contains("stale")) clearActivityNote();
}
function setActivityLabel(label = "thinking") {
  if (el.thinkingStatus) {
    el.thinkingStatus.textContent = label;
    el.thinkingStatus.classList.toggle("hidden", !rpc?.streaming);
  }
  if (rpc) rpc.activityLabel = label;
  if (pendingAssistant?.shimmerLabel) pendingAssistant.shimmerLabel.textContent = label;

  // Keep the visible work summary in sync with the RPC status.  Tool cards
  // already carry a `running` class, but the group summary is the only row a
  // user sees while it is collapsed.  Updating it here makes that one-line
  // Codex-style summary shimmer for thinking/retry/compaction as well as for
  // an active tool, then settle back to a static summary when work ends.
  const workLabels = new Set(["thinking", "working", "retrying", "compacting"]);
  const activeActivity = pendingAssistant?.activity || (liveToolCards.size ? liveActivity : null);
  if (activeActivity && workLabels.has(label)) {
    const runningCard = [...liveToolCards.values()].find((card) => card.classList.contains("running"));
    const statusText = runningCard
      ? toolTitle(runningCard.__tool?.name, runningCard.__tool?.args, true)
      : ({ thinking: "Thinking…", working: "Working…", retrying: "Retrying…", compacting: "Compacting…" }[label] || "Working…");
    updateActivityGroup(activeActivity, { running: true, latest: statusText });
  }
}

function handleRpcEvent(ev, eventSid = rpc?.sid) {
  if (eventSid && rpc?.sid !== eventSid) return;
  markRpcActivity();
  switch (ev.type) {
    case "agent_start":
      runFailureRendered = false;
      lastRunFailure = null;
      setStreaming(true);
      setActivityLabel("thinking");
      clearActivityNote();
      el.queueNote.classList.add("hidden");
      break;
    case "message_start":
      if (ev.message?.role === "assistant") ensurePendingAssistant();
      break;
    case "extension_ui_request":
      setActivityLabel("waiting");
      showExtensionUi(ev, eventSid);
      break;
    case "auto_retry_start":
      setStreaming(true);
      setActivityLabel("retrying");
      el.queueNote.textContent = `↻ 連線暫時失敗，正在重試（${ev.attempt || 1}/${ev.maxAttempts || "…"}）`;
      el.queueNote.classList.remove("hidden");
      break;
    case "auto_retry_end":
      if (ev.success === false) {
        if (!runFailureRendered) {
          renderRunFailure(lastRunFailure || {
            stopReason: "error",
            errorMessage: ev.finalError || "重試失敗，請檢查模型或連線",
          });
        }
        el.queueNote.textContent = "重試失敗，請檢查模型或連線；可按重試重新執行。";
        el.queueNote.classList.remove("hidden");
      } else {
        el.queueNote.classList.add("hidden");
      }
      break;
    case "compaction_start":
      setActivityLabel("compacting");
      el.queueNote.textContent = "正在整理對話上下文…";
      el.queueNote.classList.remove("hidden");
      break;
    case "compaction_end":
      el.queueNote.classList.add("hidden");
      appendContextDivider("Context compacted");
      break;
    case "summarization_retry_scheduled":
      setActivityLabel("retrying");
      el.queueNote.textContent = "上下文整理暫時失敗，準備重試…";
      el.queueNote.classList.remove("hidden");
      break;
    case "summarization_retry_attempt_start":
      setActivityLabel("retrying");
      el.queueNote.textContent = `正在重試整理上下文（第 ${ev.attempt || 1} 次）…`;
      el.queueNote.classList.remove("hidden");
      break;
    case "summarization_retry_finished":
      if (ev.success === false || ev.willRetry === false) {
        el.queueNote.textContent = ev.success === false
          ? "上下文整理失敗，請按停止後重試；若持續發生，請換模型或縮短對話。"
          : "上下文整理完成，正在恢復工作…";
        el.queueNote.classList.remove("hidden");
      }
      break;
    case "extension_error":
      el.queueNote.textContent = `擴充功能錯誤：${ev.message || ev.error || "未知錯誤"}`;
      el.queueNote.classList.remove("hidden");
      break;
    case "message_update": {
      const ae = ev.assistantMessageEvent;
      if (ev.usage) updateLiveUsage(ev.usage); // provider 累计用量 → header 实时显示
      if (!ae) break;
      if (ae.type === "text_start") { setActivityLabel("thinking"); ensurePendingAssistant(); }
      else if (ae.type === "text_delta") {
        setActivityLabel("writing");
        ensurePendingAssistant();
        if (pendingAssistant.shimmer) { pendingAssistant.shimmer.remove(); pendingAssistant.shimmer = null; }
        queuePendingTextDelta(ae.delta);
      } else if (ae.type === "thinking_delta") {
        setActivityLabel("thinking");
        ensurePendingAssistant();
        if (pendingAssistant.shimmer) { pendingAssistant.shimmer.remove(); pendingAssistant.shimmer = null; }
        if (!pendingAssistant.thinkEl) {
          pendingAssistant.thinkEl = makeThinking("");
          const activity = ensureActivityGroup({ bubble: pendingAssistant.bubble, running: true });
          if (activity) activity.body.appendChild(pendingAssistant.thinkEl);
        }
        pendingAssistant.thinkEl.querySelector(".thinking-block").textContent += ae.delta;
      } else if (ae.type === "toolcall_end" && ae.toolCall) {
        setActivityLabel("working");
        appendLiveToolCard(ae.toolCall.id, ae.toolCall.name, ae.toolCall.arguments);
        scrollBottom();
      }
      break;
    }
    case "message_end": {
      const m = ev.message;
      if (m && m.role === "assistant") {
        const current = pendingAssistant;
        const full = wireFromAgentMessage(m);
        if (isFailureMessage(full)) {
          lastRunFailure = full;
          renderRunFailure(full, { shell: current || null });
          break;
        }
        flushPendingText(current);
        const { wrap, bubble } = current || makeMsgShell("assistant", "pi");
        if (current) current.activity = null;
        bubble.innerHTML = "";
        // The streamed preview is replaced by the authoritative message_end
        // snapshot; discard detached card references before rebuilding it.
        liveToolCards = new Map();
        liveActivity = null;
        let activity = null;
        if (full.thinking || full.toolCalls.length) {
          activity = ensureActivityGroup({ bubble, running: full.toolCalls.length > 0 });
          if (full.thinking && activity) activity.body.appendChild(makeThinking(full.thinking));
        }
        if (full.text) bubble.appendChild(renderMarkdown(full.text));
        // Pi emits message_end before tool_execution_start. Keep tool rows in
        // the running state so the next execution events can update them.
        for (const tc of full.toolCalls) {
          const card = appendLiveToolCard(tc.id, tc.name, tc.args);
          if (card) card.dataset.toolCallId = tc.id || "";
        }
        if (full.usage) {
          attachMessageUsage(wrap, full.usage, activity);
          addSessionUsage(full.usage);
        }
        wrap.appendChild(msgActionsRow("assistant", () => full.text));
        mergeAdjacentWorkMessages();
        if (full.toolCalls.length) {
          if (current?.shimmer) current.shimmer.remove();
          pendingAssistant = null;
          setActivityLabel("working");
        } else {
          finalizePending();
          liveToolCards = new Map();
        }
      } else if (m && m.role === "toolResult") {
        attachLiveToolResult(m);
      }
      break;
    }
    case "turn_end": {
      const ended = ev.message ? wireFromAgentMessage(ev.message) : null;
      if (isFailureMessage(ended)) {
        lastRunFailure = ended;
        if (!runFailureRendered) renderRunFailure(ended);
      }
      break;
    }
    case "agent_end": {
      const failed = (Array.isArray(ev.messages) ? ev.messages : [])
        .map(wireFromAgentMessage)
        .find(isFailureMessage);
      if (!failed) break;
      lastRunFailure = failed;
      if (ev.willRetry) {
        setActivityLabel("retrying");
        const detail = String(failed.errorMessage || "暫時失敗").trim();
        el.queueNote.textContent = `模型暫時失敗，準備重試：${detail.slice(0, 260)}`;
        el.queueNote.classList.remove("hidden");
      } else if (!runFailureRendered) {
        renderRunFailure(failed);
      }
      break;
    }
    case "tool_execution_start": {
      setActivityLabel("working");
      const card = appendLiveToolCard(ev.toolCallId, ev.toolName, ev.args);
      setToolCardState(card, { running: true });
      scrollBottom();
      break;
    }
    case "tool_execution_update": {
      setActivityLabel("working");
      const card = liveToolCards.get(ev.toolCallId) || appendLiveToolCard(ev.toolCallId, ev.toolName, ev.args);
      const partial = (ev.partialResult?.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
      if (card && partial) card.querySelector(".tool-output").textContent = partial;
      break;
    }
    case "tool_execution_end": {
      setActivityLabel("thinking");
      const card = liveToolCards.get(ev.toolCallId) || appendLiveToolCard(ev.toolCallId, ev.toolName, ev.args);
      if (card) {
        const txt = (ev.result?.content || []).filter(c => c.type === "text").map(c => c.text).join("\n");
        setToolCardState(card, { running: false, isError: !!ev.isError, text: txt });
      }
      if (ev.toolCallId) liveToolCards.delete(ev.toolCallId);
      if (liveActivity) {
        updateActivityGroup(liveActivity, {
          running: liveToolCards.size > 0,
          latest: toolTitle(ev.toolName, ev.args, liveToolCards.size > 0),
          hasError: liveActivity.hasError || !!ev.isError,
        });
      }
      break;
    }
    case "queue_update": {
      const n = (ev.steering?.length || 0) + (ev.followUp?.length || 0);
      el.queueNote.textContent = n > 0 ? `⏳ ${n} 則訊息排隊中` : "";
      el.queueNote.classList.toggle("hidden", n === 0);
      if (n > 0) el.queueNote.dataset.persistent = "queue";
      else delete el.queueNote.dataset.persistent;
      break;
    }
    case "agent_settled":
      if (lastRunFailure && !runFailureRendered) renderRunFailure(lastRunFailure);
      setStreaming(false);
      finalizePending({ settleTools: true });
      el.queueNote.classList.add("hidden");
      clearActivityNote();
      break;
    case "response":
      if (ev.command === "get_state" && ev.success && ev.data?.sessionFile) {
        trackCurrentSessionFile(ev.data.sessionFile);
      }
      break;
    case "rpc_exit":
      if (rpc?.sid === eventSid) {
        rpc.streamEnded = true;
        if (rpc.reconnectTimer) clearTimeout(rpc.reconnectTimer);
        if (rpc.readyTimer) clearTimeout(rpc.readyTimer);
        rpc.reconnectTimer = null;
        rpc.readyTimer = null;
      }
      setStreaming(false);
      finalizePending({ settleTools: true });
      clearActivityNote();
      {
        const unexpectedExit = ev.error || ev.wasStreaming || (ev.code !== 0 && ev.code !== null && ev.code !== undefined);
        if (!runFailureRendered && unexpectedExit) {
          const detail = ev.stderrTail ? String(ev.stderrTail).slice(-2000) : "";
          const title = ev.error ? "Pi 無法啟動" : "Pi 工作程序已中斷";
          const reason = ev.error || [
            ev.signal ? `signal ${ev.signal}` : null,
            ev.code !== undefined && ev.code !== null ? `code ${ev.code}` : null,
          ].filter(Boolean).join("、") || "沒有收到結束原因";
          renderRunFailure({ stopReason: "error", errorMessage: `${reason}${detail ? `\n${detail}` : ""}` }, {
            title,
            settleTools: false,
          });
        }
        scrollBottom();
      }
      break;
  }
}
function appendContextDivider(label = "Context compacted") {
  const divider = document.createElement("div");
  divider.className = "context-divider";
  const text = document.createElement("span");
  text.textContent = label;
  divider.appendChild(text);
  el.messages.appendChild(divider);
  keepSessionUsageAtEnd();
  scrollBottom();
}

function wireFromAgentMessage(m) {
  const out = {
    role: m?.role || null, text: "", thinking: "", toolCalls: [], imageAttachments: [], images: 0, usage: null,
    stopReason: m?.stopReason || null,
    errorMessage: m?.errorMessage ? String(m.errorMessage).slice(0, 8000) : "",
    model: m?.model || null,
    provider: m?.provider || null,
    api: m?.api || null,
  };
  for (const c of Array.isArray(m?.content) ? m.content : []) {
    if (c.type === "text") out.text += (out.text ? "\n\n" : "") + c.text;
    else if (c.type === "thinking") out.thinking += c.thinking || "";
    else if (c.type === "toolCall") out.toolCalls.push({ id: c.id || null, name: c.name, args: c.arguments });
  }
  if (m?.role === "user") {
    const parts = Array.isArray(m.content) ? m.content.filter((c) => c && c.type === "image") : [];
    out.images = parts.length;
    out.imageAttachments = parts.map(normalizeImageAttachment).filter(Boolean);
  }
  if (m.usage) out.usage = {
    tokens: (m.usage.input||0)+(m.usage.output||0)+(m.usage.cacheRead||0)+(m.usage.cacheWrite||0),
    cost: m.usage.cost?.total ?? null,
  };
  return out;
}

function isFailureMessage(m) {
  return !!m && (!m.role || m.role === "assistant") && (
    m.stopReason === "error" || m.stopReason === "aborted" || !!String(m.errorMessage || "").trim()
  );
}

function errorTitleFor(stopReason, fallback = "工作失敗") {
  if (fallback) return fallback;
  if (stopReason === "aborted") return "工作已中止";
  return "工作失敗";
}

function appendRunError(bubble, data = {}, options = {}) {
  if (!bubble) return null;
  const previous = bubble.querySelector(":scope > .run-error");
  if (previous) previous.remove();
  const box = document.createElement("div");
  box.className = "run-error";
  const title = document.createElement("div");
  title.className = "run-error-title";
  title.textContent = errorTitleFor(data.stopReason, options.title || "");
  box.appendChild(title);
  const message = String(options.message || data.errorMessage || "").trim() || (
    data.stopReason === "aborted"
      ? "這次工作被停止，沒有產生完整回覆。"
      : "Pi 沒有提供錯誤原因，請檢查連線或按重試。"
  );
  const detail = document.createElement("div");
  detail.className = "run-error-message";
  detail.textContent = message.slice(0, 8000);
  box.appendChild(detail);
  bubble.appendChild(box);
  return box;
}

function assistantShellForError() {
  if (pendingAssistant) return { wrap: pendingAssistant.wrap, bubble: pendingAssistant.bubble };
  const bubble = liveActivity?.details?.closest(".bubble");
  const wrap = bubble?.closest(".msg");
  if (wrap && bubble) return { wrap, bubble };
  return null;
}

function renderRunFailure(data = {}, options = {}) {
  const shell = options.shell || assistantShellForError() || makeMsgShell("assistant", "pi");
  const activity = pendingAssistant?.activity || liveActivity;
  if (pendingAssistant?.shimmer) {
    pendingAssistant.shimmer.remove();
    pendingAssistant.shimmer = null;
  }
  flushPendingText(pendingAssistant);
  if (activity) updateActivityGroup(activity, { running: false, hasError: true });
  if (options.settleTools !== false) settleLiveToolCards();
  pendingAssistant = null;
  liveActivity = activity || null;
  appendRunError(shell.bubble, data, options);
  if (![...shell.wrap.children].some((child) => child.classList.contains("msg-actions"))) {
    shell.wrap.appendChild(msgActionsRow("assistant", () => data.errorMessage || ""));
  }
  runFailureRendered = true;
  scrollBottom();
  return shell;
}
function ensurePendingAssistant() {
  if (pendingAssistant) return;
  const { wrap, bubble } = makeMsgShell("assistant", "pi");
  const shimmer = document.createElement("div");
  shimmer.className = "thinking-shimmer";
  const shimmerLabel = document.createElement("span");
  shimmerLabel.className = "thinking-label";
  shimmerLabel.textContent = "thinking";
  const shimmerDots = document.createElement("span");
  shimmerDots.textContent = "…";
  shimmer.append(shimmerLabel, shimmerDots);
  const textEl = document.createTextNode("");
  bubble.appendChild(shimmer);
  bubble.appendChild(textEl);
  pendingAssistant = { wrap, bubble, textEl, textBuffer: "", textFrame: null, thinkEl: null, shimmer, shimmerLabel, activity: null };
  scrollBottom();
}
function flushPendingText(target = pendingAssistant) {
  if (!target) return;
  if (target.textFrame) cancelAnimationFrame(target.textFrame);
  target.textFrame = null;
  if (!target.textBuffer) return;
  target.textEl.textContent += target.textBuffer;
  target.textBuffer = "";
}
function queuePendingTextDelta(delta) {
  const target = pendingAssistant;
  if (!target) return;
  target.textBuffer += String(delta || "");
  if (target.textFrame) return;
  target.textFrame = requestAnimationFrame(() => {
    target.textFrame = null;
    if (pendingAssistant !== target && !target.textEl.isConnected) {
      target.textBuffer = "";
      return;
    }
    flushPendingText(target);
    scrollBottom();
  });
}
function settleLiveToolCards() {
  let hadIncomplete = false;
  for (const card of liveToolCards.values()) {
    const output = card.querySelector(".tool-output")?.textContent || "";
    const incomplete = !output || output === "（執行中…）";
    hadIncomplete = hadIncomplete || incomplete;
    setToolCardState(card, {
      running: false,
      isError: incomplete,
      text: incomplete ? "工作在完成事件前停止；請檢查連線或重試。" : output,
    });
  }
  liveToolCards = new Map();
  if (liveActivity) updateActivityGroup(liveActivity, { running: false, hasError: liveActivity.hasError || hadIncomplete });
}
function finalizePending({ settleTools = false } = {}) {
  flushPendingText(pendingAssistant);
  if (pendingAssistant && pendingAssistant.shimmer) pendingAssistant.shimmer.remove();
  const activity = pendingAssistant?.activity || liveActivity;
  if (activity && (settleTools || liveToolCards.size === 0)) updateActivityGroup(activity, { running: false });
  pendingAssistant = null;
  if (settleTools) settleLiveToolCards();
}
function attachLiveToolResult(m) {
  const txt = (Array.isArray(m.content) ? m.content : []).filter(c => c.type === "text").map(c => c.text).join("\n");
  if (liveToolCards.size) {
    const last = [...liveToolCards.values()].pop();
    const body = last.querySelector(".tool-output");
    if (body && body.textContent === "（執行中…）") {
      setToolCardState(last, { running: false, isError: !!m.isError, text: txt });
      return;
    }
  }
  attachToolResult(m.toolName, m.isError, txt);
}
let liveUsageTokens = 0; let liveUsageCost = 0; let baseUsageTokens = 0;
function resetLiveUsage() { liveUsageTokens = 0; liveUsageCost = 0; baseUsageTokens = 0; updateLiveUsage(null); }
function updateLiveUsage(u) {
  if (u) {
    const t = (u.input||0)+(u.output||0)+(u.cacheRead||0)+(u.cacheWrite||0);
    if (t) liveUsageTokens = Math.max(liveUsageTokens, t);
    if (u.cost && Number.isFinite(u.cost.total)) liveUsageCost = u.cost.total;
  }
  const base = el.chatSub.dataset.base || "";
  // Keep usage in one place at the bottom of the conversation.  The header
  // remains the compact cwd/status line instead of repeating tok/$ per turn.
  el.chatSub.textContent = base;
}
function setStreaming(on) {
  if (rpc) rpc.streaming = on;
  if (on) {
    if (rpc && !rpc.lastEventAt) rpc.lastEventAt = Date.now();
    if (!activityWatchdog) activityWatchdog = setInterval(updateActivityWatchdog, 5000);
  } else if (activityWatchdog) {
    clearInterval(activityWatchdog);
    activityWatchdog = null;
    clearActivityNote();
  }
  el.streamDot.classList.toggle("hidden", !on);
  el.thinkingStatus?.classList.toggle("hidden", !on);
  if (on && el.thinkingStatus && !el.thinkingStatus.textContent) el.thinkingStatus.textContent = "thinking";
  el.btnAbort.classList.toggle("hidden", !on);
  el.btnSend.classList.toggle("hidden", on);
  el.btnSend.title = on ? "" : "送出";
  el.btnAbort.title = on ? "停止" : "";
}

// ---- 送出 / 中止 ----
el.btnSend.addEventListener("click", sendCurrent);
el.btnModel.addEventListener("click", openModelSheet);
el.input.addEventListener("keydown", (e) => {
  // slash 選單鍵盤導航
  if (slashState && el.slashMenu && !el.slashMenu.classList.contains("hidden")) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      slashState.hl = (slashState.hl + (e.key === "ArrowDown" ? 1 : -1) + slashState.items.length) % slashState.items.length;
      [...el.slashMenu.children].forEach((c, i) => c.classList.toggle("hl", i === slashState.hl));
      return;
    }
    if (e.key === "Tab" || (e.key === "Enter" && !e.isComposing)) {
      e.preventDefault();
      pickSlash(slashState.items[slashState.hl]);
      return;
    }
    if (e.key === "Escape") { el.slashMenu.classList.add("hidden"); slashState = null; return; }
  }
  // 手機（coarse pointer）：Enter 一律換行，發送只靠按鈕；桌面 Enter 發送
  const isDesktop = matchMedia("(min-width: 980px)").matches;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && isDesktop) { e.preventDefault(); sendCurrent(); }
});
el.input.addEventListener("input", () => {
  el.input.style.height = "auto";
  el.input.style.height = Math.min(el.input.scrollHeight, 120) + "px";
  updateSlashMenu();
});

// ---- 圖片附件（手機拍照／相冊／剪貼簿貼上 → base64）----
let pendingImages = []; // [{data, mimeType}]
const MAX_PENDING_IMAGES = 4;
const MAX_IMAGE_FILE_BYTES = 24 * 1024 * 1024;

function imageFileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type?.startsWith("image/")) return reject(new Error("不是圖片檔案"));
    if (file.size > MAX_IMAGE_FILE_BYTES) return reject(new Error("圖片太大，請先壓縮後再貼上"));
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    const cleanup = () => URL.revokeObjectURL(objectUrl);
    image.onload = () => {
      try {
        const maxSide = 1800;
        const scale = Math.min(1, maxSide / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
        canvas.height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("無法處理圖片");
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        let type = file.type === "image/png" && file.size < 2 * 1024 * 1024 ? "image/png" : "image/jpeg";
        if (!canvas.toBlob) {
          const reader = new FileReader();
          reader.onload = () => { cleanup(); resolve({ data: String(reader.result), mimeType: file.type || "image/jpeg" }); };
          reader.onerror = () => { cleanup(); reject(new Error("圖片讀取失敗")); };
          reader.readAsDataURL(file);
          return;
        }
        canvas.toBlob((blob) => {
          cleanup();
          if (!blob) { reject(new Error("圖片壓縮失敗")); return; }
          const reader = new FileReader();
          reader.onload = () => resolve({ data: String(reader.result), mimeType: blob.type || type });
          reader.onerror = () => reject(new Error("圖片讀取失敗"));
          reader.readAsDataURL(blob);
        }, type, 0.84);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    image.onerror = () => { cleanup(); reject(new Error("無法讀取圖片")); };
    image.src = objectUrl;
  });
}

async function addImageFiles(files) {
  let added = 0;
  for (const file of Array.from(files || [])) {
    if (pendingImages.length >= MAX_PENDING_IMAGES) { toast("最多 4 張圖片", true); break; }
    if (!file?.type?.startsWith("image/")) continue;
    try {
      pendingImages.push(await imageFileToDataUrl(file));
      added++;
      renderImgPreview();
    } catch (error) {
      toast(error.message || "圖片處理失敗", true);
    }
  }
  if (added) toast(`${added} 張圖片已加入`);
}

el.btnImg.addEventListener("click", () => el.fileInput.click());
el.fileInput.addEventListener("change", () => {
  void addImageFiles(el.fileInput.files);
  el.fileInput.value = "";
});

function insertTextAtCursor(text) {
  const start = el.input.selectionStart ?? el.input.value.length;
  const end = el.input.selectionEnd ?? start;
  el.input.value = el.input.value.slice(0, start) + text + el.input.value.slice(end);
  el.input.selectionStart = el.input.selectionEnd = start + text.length;
  el.input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function clipboardApiImages() {
  if (!navigator.clipboard?.read) return [];
  try {
    const clipboardItems = await navigator.clipboard.read();
    const files = [];
    for (const item of clipboardItems) {
      const type = item.types.find((value) => value.startsWith("image/"));
      if (!type) continue;
      const blob = await item.getType(type);
      files.push(new File([blob], `clipboard.${type.split("/")[1] || "png"}`, { type }));
    }
    return files;
  } catch {
    return [];
  }
}

async function clipboardHtmlImages(html) {
  const urls = [...String(html || "").matchAll(/<img[^>]+src=["'](data:image\/[^"']+)["']/gi)].map((match) => match[1]);
  const files = [];
  for (const dataUrl of urls.slice(0, MAX_PENDING_IMAGES)) {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      files.push(new File([blob], "clipboard-image", { type: blob.type || "image/png" }));
    } catch {}
  }
  return files;
}

// 不同瀏覽器對圖片剪貼簿的暴露方式不同：clipboard.items、clipboard.files、HTML data URL，
// 最後再嘗試 Clipboard API。用 document listener 也能覆蓋 iOS Safari 的特殊 paste target。
async function handleImagePaste(event) {
  if (event.target !== el.input) return;
  const clipboard = event.clipboardData;
  const items = Array.from(clipboard?.items || []);
  const itemFiles = items.map((item) => item.kind === "file" ? item.getAsFile() : null).filter(Boolean);
  const fileList = Array.from(clipboard?.files || []).filter((file) => file.type?.startsWith("image/"));
  const html = clipboard?.types?.includes("text/html") ? clipboard.getData("text/html") : "";
  const htmlLooksLikeImage = /<img[^>]+src=["'](?:data:image\/|blob:)/i.test(html);
  const typesSuggestImage = items.some((item) => item.type?.startsWith("image/")) || clipboard?.types?.includes?.("Files") || clipboard?.types?.some?.((type) => type.startsWith("image/"));
  const files = [...new Set([...itemFiles, ...fileList])];
  const htmlFiles = files.length || !htmlLooksLikeImage ? [] : await clipboardHtmlImages(html);
  let apiFiles = [];

  // 有些 Safari 版本不把圖片放進 paste event，只能由 Clipboard API 取出。
  // 沒有任何圖片線索時不阻止一般文字貼上；API 若讀到圖片，則額外加入附件。
  if (!files.length && !htmlFiles.length && !typesSuggestImage) {
    apiFiles = await clipboardApiImages();
    if (!apiFiles.length) return;
  } else {
    event.preventDefault();
    const textItem = items.find((item) => item.kind === "string" && item.type === "text/plain");
    if (textItem) textItem.getAsString((text) => { if (text) insertTextAtCursor(text); });
    if (!files.length && !htmlFiles.length) apiFiles = await clipboardApiImages();
  }

  const allFiles = [...files, ...htmlFiles, ...apiFiles];
  if (!allFiles.length) {
    toast("瀏覽器沒有提供可讀取的圖片，請先點擊輸入框再貼上", true);
    return;
  }
  toast("正在加入圖片…");
  await addImageFiles(allFiles);
}
document.addEventListener("paste", (event) => { void handleImagePaste(event); });

function renderImgPreview() {
  el.imgPreview.innerHTML = "";
  el.imgPreview.classList.toggle("hidden", pendingImages.length === 0);
  pendingImages.forEach((im, i) => {
    const wrap = document.createElement("div");
    wrap.className = "img-thumb";
    const img = document.createElement("img");
    img.src = im.data;
    const x = document.createElement("button");
    x.className = "img-x";
    x.type = "button";
    x.title = "移除圖片";
    x.setAttribute("aria-label", "移除圖片");
    x.textContent = "×";
    x.addEventListener("click", () => { pendingImages.splice(i, 1); renderImgPreview(); });
    wrap.appendChild(img); wrap.appendChild(x);
    el.imgPreview.appendChild(wrap);
  });
}

async function sendCurrent() {
  let text = el.input.value.trim();
  if ((!text && !pendingImages.length) || !rpc) return;
  el.input.value = "";
  el.input.style.height = "auto";
  el.slashMenu.classList.add("hidden");
  slashState = null;

  // 內建 TUI 指令映射（/compact 等 RPC 專屬）
  const bm = text.match(/^\/(compact|clear)\s*$/i);
  if (bm) {
    const cmd = bm[1].toLowerCase();
    if (cmd === "compact") { await BUILTIN_SLASH.compact(); return; }
    if (cmd === "clear") { showList(); return; }
  }

  maybeDateSeparator(Date.now());
  lastUserText = text;
  const { bubble } = makeMsgShell("user", "你");
  if (text) bubble.appendChild(renderMarkdown(text));
  if (pendingImages.length) appendImageGallery(bubble, pendingImages, pendingImages.length);
  scrollBottom();
  const sendSid = rpc.sid;
  const images = pendingImages.slice();
  pendingImages = [];
  renderImgPreview();
  try {
    const result = await post("/api/send", { sid: sendSid, message: text, images }); // /skill:xxx 等直接透傳，pi 原生處理
    if (result?.queued && rpc?.sid === sendSid) {
      el.queueNote.dataset.persistent = "queue";
      el.queueNote.textContent = "訊息已排隊，等目前工作完成後會繼續處理。";
      el.queueNote.classList.remove("hidden");
    }
  } catch (e) {
    if (rpc?.sid === sendSid) {
      el.input.value = text;
      pendingImages = images.concat(pendingImages).slice(0, 4);
      renderImgPreview();
      toast("訊息沒送出去，已保留草稿", true);
    }
  }
}
el.btnAbort.addEventListener("click", () => {
  if (rpc) post("/api/abort", { sid: rpc.sid }).catch(() => {});
});

// ---- chat ⋯ menu：重命名目前 session / 返回列表 ----
el.btnChatMenu.addEventListener("click", () => {
  if (currentSessionFile) { openSessionActions({ ...actionStubFrom(currentSessionFile) }); }
  else toast("新對話還沒存檔，先講一句話吧");
});
let currentSessionFile = null;
function actionStubFrom(file) {
  const s = sessionsCache.find(x => x.file === file);
  return s || { file, name: el.chatTitle.textContent, preview: "", cwd: currentSessionCwd };
}
function trackCurrentSessionFile(absPath) {
  const normalized = String(absPath || "").replaceAll("\\", "/").replace(/\/+$/, "");
  if (sessionsCache.length && normalized) {
    const hit = sessionsCache.find((s) => {
      const relative = String(s.file || "").replaceAll("\\", "/").replace(/^\/+/, "");
      return normalized.endsWith("/" + relative) || normalized === relative;
    });
    if (hit) { currentSessionFile = hit.file; return; }
  }
  currentSessionFile = absPath;
  // 新對話首次寫檔時列表尚未有它，重新掃描後再把絕對路徑解析成相對 session file。
  refreshSessions().then(() => {
    const hit = sessionsCache.find((s) => {
      const relative = String(s.file || "").replaceAll("\\", "/").replace(/^\/+/, "");
      return normalized.endsWith("/" + relative) || normalized === relative;
    });
    if (hit) {
      currentSessionFile = hit.file;
      renderSessionList(el.search.value);
    }
  }).catch(() => {});
}

// ---- ⋯ 菜單：模型切換入口 ----
function applyComposerState(data) {
  const model = data?.model;
  el.composerModelLabel.textContent = model?.name || model?.id || "伺服器預設";
  const level = data?.thinkingLevel;
  if (level) {
    el.thinkingSelect.value = level;
    el.composerThinking.value = level;
  }
}
async function syncComposerState(expectedSid = rpc?.sid) {
  if (!expectedSid || !rpc || rpc.sid !== expectedSid) return;
  try {
    const r = await rpcCmd(expectedSid, { type: "get_state" });
    if (rpc?.sid === expectedSid && r?.success) applyComposerState(r.data);
  } catch {}
}
el.saModel.addEventListener("click", () => {
  closeSessionActions();
  openModelSheet();
});

let availableModels = [];
async function openModelSheet() {
  const expectedSid = rpc?.sid;
  if (!expectedSid) { toast("對話未開啟"); return; }
  el.modelSheet.classList.remove("hidden");
  el.modelList.innerHTML = '<p style="padding:12px 4px;color:var(--pine-soft);font-size:13.5px">讀取中…</p>';
  try {
    const [modelsRes, stateRes] = await Promise.allSettled([
      rpcCmd(expectedSid, { type: "get_available_models" }),
      rpcCmd(expectedSid, { type: "get_state" }),
    ]);
    if (!rpc || rpc.sid !== expectedSid) { el.modelSheet.classList.add("hidden"); return; }
    if (modelsRes.status === "fulfilled" && modelsRes.value && modelsRes.value.success) {
      availableModels = (modelsRes.value.data && modelsRes.value.data.models) || [];
    }
    let currentId = null, curThinking = null;
    if (stateRes.status === "fulfilled" && stateRes.value && stateRes.value.success) {
      currentId = (stateRes.value.data && stateRes.value.data.model && stateRes.value.data.model.id) || null;
      curThinking = stateRes.value.data ? stateRes.value.data.thinkingLevel : null;
      applyComposerState(stateRes.value.data);
    }
    renderModelList(currentId);
    if (curThinking) {
      el.thinkingSelect.value = curThinking;
      el.composerThinking.value = curThinking;
    }
  } catch (e) {
    el.modelList.innerHTML = "";
    const error = document.createElement("p");
    error.className = "model-load-error";
    error.textContent = "讀取失敗：" + (e.message || "unknown error");
    el.modelList.appendChild(error);
  }
}

function renderModelList(currentId) {
  const current = availableModels.find(m => m.id === currentId);
  const visibleModels = availableModels.filter(isModelVisible);
  el.composerModelLabel.textContent = current ? (current.name || current.id) : "伺服器預設";
  el.modelList.innerHTML = "";
  if (!visibleModels.length) {
    el.modelList.innerHTML = '<p style="padding:12px 4px;color:var(--pine-soft);font-size:13.5px">沒有顯示中的模型，請到設定勾選模型</p>';
    return;
  }
  for (const m of visibleModels) {
    const row = document.createElement("button");
    row.className = "action-row model-row" + (m.id === currentId ? " active" : "");
    row.type = "button";
    row.innerHTML = '<span class="model-check"></span><span class="model-info"><strong></strong><small></small></span>';
    row.querySelector(".model-check").textContent = m.id === currentId ? "✓" : "";
    row.querySelector("strong").textContent = m.name || m.id;
    row.querySelector("small").textContent = (m.provider || "?") + (m.contextWindow ? " · " + Math.round(m.contextWindow/1000) + "k ctx" : "");
    row.addEventListener("click", async () => {
      const expectedSid = rpc?.sid;
      if (!expectedSid) return;
      try {
        await rpcCmd(expectedSid, { type: "set_model", provider: m.provider, modelId: m.id });
        if (!rpc || rpc.sid !== expectedSid) return;
        toast("模型：" + (m.name || m.id));
        el.composerModelLabel.textContent = m.name || m.id;
        renderModelList(m.id);
        // 頂部 sub 同步
        el.chatSub.dataset.base = currentSessionCwd + " · " + (m.name || m.id); updateLiveUsage(null);
      } catch (e) { toast("切換失敗：" + e.message, true); }
    });
    el.modelList.appendChild(row);
  }
}

function closeModelSheet() { el.modelSheet.classList.add("hidden"); }
el.modelClose.addEventListener("click", closeModelSheet);
el.modelSheet.addEventListener("click", (event) => {
  if (event.target === el.modelSheet) closeModelSheet();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !el.modelSheet.classList.contains("hidden")) closeModelSheet();
});
async function changeThinkingLevel(level) {
  const expectedSid = rpc?.sid;
  if (!expectedSid) return;
  try {
    const r = await rpcCmd(expectedSid, { type: "set_thinking_level", level });
    if (!rpc || rpc.sid !== expectedSid) return;
    if (r && r.success === false) throw new Error(r.error || "RPC rejected");
    el.thinkingSelect.value = level;
    el.composerThinking.value = level;
    toast("思考等級：" + level);
  } catch (e) { toast("設定失敗：" + e.message, true); }
}
el.thinkingSelect.addEventListener("change", () => changeThinkingLevel(el.thinkingSelect.value));
el.composerThinking.addEventListener("change", () => changeThinkingLevel(el.composerThinking.value));

// ===========================================================================
// Markdown / Mermaid Rich 渲染
// ===========================================================================

const HAS_MD = typeof marked !== "undefined" && typeof DOMPurify !== "undefined";
let mermaidReady = false, mermaidLoading = null;
function ensureMermaid() {
  if (mermaidReady || mermaidLoading) return mermaidLoading;
  mermaidLoading = import("https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs")
    .then((mod) => {
      mod.default.initialize({ securityLevel: "strict", startOnLoad: false, theme: document.documentElement.dataset.theme === "dark" || (settings.theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "neutral", fontFamily: "-apple-system, sans-serif" });
      mermaidReady = true;
      return mod.default;
    })
    .catch(() => { mermaidLoading = null; return null; });
  return mermaidLoading;
}

function enhanceCodeBlocks(root) {
  for (const pre of root.querySelectorAll("pre")) {
    if (pre.parentElement?.classList.contains("code-block")) continue;
    const code = pre.querySelector("code");
    if (!code) continue;
    const langClass = [...code.classList].find(c => c.startsWith("language-"));
    const language = langClass ? langClass.slice("language-".length) : "code";
    const shell = document.createElement("div");
    shell.className = "code-block";
    const header = document.createElement("div");
    header.className = "code-block-header";
    const label = document.createElement("span");
    label.textContent = language;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "code-copy-button";
    copy.textContent = "複製";
    copy.addEventListener("click", async () => {
      try {
        await copyText(code.textContent || "");
        copy.textContent = "已複製";
        setTimeout(() => { copy.textContent = "複製"; }, 1400);
      } catch { copy.textContent = "複製失敗"; }
    });
    header.append(label, copy);
    pre.replaceWith(shell);
    shell.append(header, pre);
  }
}

function renderMarkdown(text) {
  if (!HAS_MD) {
    const d = document.createElement("div");
    d.className = "md-body";
    d.textContent = text; // 無庫時退化为纯文字
    return d;
  }
  const raw = marked.parse(text, { breaks: true, gfm: true });
  const clean = DOMPurify.sanitize(raw, { ADD_ATTR: ["target"] });
  const d = document.createElement("div");
  d.className = "md-body";
  d.innerHTML = clean;
  // 外链新窗口打开
  for (const a of d.querySelectorAll("a[href]")) { a.target = "_blank"; a.rel = "noopener"; }
  // mermaid 块 → 占位容器，异步渲染
  for (const code of d.querySelectorAll("pre > code.language-mermaid")) {
    const src = code.textContent;
    const pre = code.parentElement;
    const box = document.createElement("div");
    box.className = "mermaid-block";
    box.textContent = "⏳ 圖表渲染中…";
    pre.replaceWith(box);
    ensureMermaid().then((mm) => {
      if (!mm) { box.textContent = src; box.classList.add("mermaid-error"); return; }
      mm.render("mmd" + Math.random().toString(36).slice(2), src).then(({ svg }) => {
        box.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true } });
      }).catch((e) => {
        box.innerHTML = "";
        const err = document.createElement("div");
        err.className = "mermaid-error";
        err.textContent = "圖表語法錯誤：\n" + src;
        box.appendChild(err);
      });
    });
  }
  enhanceCodeBlocks(d);
  return d;
}

// ===========================================================================
// Slash 指令（終端能輸的這裡都能輸）
// ===========================================================================

let availableCommands = [];   // [{name, description, source}] 由 get_commands 快取
let slashState = null;        // {items, hl}

async function refreshCommands(expectedSid = rpc?.sid) {
  if (!expectedSid || !rpc || rpc.sid !== expectedSid) return [];
  try {
    const r = await rpcCmd(expectedSid, { type: "get_commands" });
    if (rpc?.sid === expectedSid && r && r.success) availableCommands = (r.data && r.data.commands) || [];
  } catch {}
  return availableCommands;
}

function updateSlashMenu() {
  const v = el.input.value;
  const m = v.match(/^\/([a-z0-9:_-]*)$/i); // 只在「純指令」時提示
  if (!m || !rpc || !availableCommands.length) { el.slashMenu.classList.add("hidden"); slashState = null; return; }
  const q = m[1].toLowerCase();
  const items = availableCommands.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8);
  if (!items.length) { el.slashMenu.classList.add("hidden"); slashState = null; return; }
  slashState = { items, hl: 0 };
  el.slashMenu.innerHTML = "";
  items.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "slash-item" + (i === 0 ? " hl" : "");
    row.innerHTML = `<span class="s-cmd"></span><span class="s-desc"></span>`;
    row.querySelector(".s-cmd").textContent = "/" + c.name;
    row.querySelector(".s-desc").textContent = c.description || (c.source === "skill" ? "skill" : c.source || "");
    row.addEventListener("click", () => pickSlash(c));
    el.slashMenu.appendChild(row);
  });
  el.slashMenu.classList.remove("hidden");
}
function pickSlash(c) {
  el.input.value = "/" + c.name + " ";
  el.slashMenu.classList.add("hidden");
  slashState = null;
  el.input.focus();
}

/** 內建 TUI 指令映射：/compact 等 RPC 專屬命令 */
const BUILTIN_SLASH = {
  compact: async () => {
    if (!rpc) { toast("對話未開啟", true); return true; }
    setStreaming(true);
    try {
      const r = await rpcCmd(rpc.sid, { type: "compact" });
      if (r.success) toast(`已壓縮：${fmtTokens(r.data?.tokensBefore)} → ${fmtTokens(r.data?.estimatedTokensAfter)} tok`);
      else toast("壓縮失敗：" + (r.error || "unknown"), true);
    } catch (e) { toast("壓縮失敗：" + e.message, true); }
    setStreaming(false);
    return true;
  },
};

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("copy failed");
}

function msgActionsRow(role, getText) {
  const row = document.createElement("div");
  row.className = "msg-actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "⧉ 複製";
  copy.addEventListener("click", async () => {
    try { await copyText(getText() || ""); toast("已複製"); }
    catch { toast("複製失敗", true); }
  });
  row.appendChild(copy);
  if (role === "assistant" && lastUserText) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "↻ 重試";
    retry.addEventListener("click", () => {
      if (!rpc) return;
      const { bubble } = makeMsgShell("user", "你");
      bubble.textContent = lastUserText;
      scrollBottom();
      post("/api/send", { sid: rpc.sid, message: lastUserText }).catch(() => toast("送出失敗", true));
    });
    row.appendChild(retry);
  }
  return row;
}

let _lastMsgDate = null; let lastUserText = "";
let runFailureRendered = false;
let lastRunFailure = null;
function maybeDateSeparator(ts) {
  if (!ts) return;
  const d = new Date(ts);
  const key = d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate();
  if (_lastMsgDate === key) return;
  _lastMsgDate = key;
  const div = document.createElement("div");
  div.className = "date-sep";
  div.textContent = `${d.getMonth() + 1}/${d.getDate()}`;
  el.messages.appendChild(div);
  keepSessionUsageAtEnd();
}

(() => {
  const EDGE = 36;       // 起點必須在左緣內
  const DIST = 90;       // 完成閾值 px
  const RATIO = 1.6;     // 水平/垂直比
  let g = null;

  el.viewChat.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    if (t.clientX > EDGE) return;
    if (e.target.closest("textarea")) return;
    g = { x0: t.clientX, y0: t.clientY, t0: Date.now(), dx: 0, active: false };
  }, { passive: true });

  el.viewChat.addEventListener("touchmove", (e) => {
    if (!g) return;
    const t = e.touches[0];
    const dx = t.clientX - g.x0, dy = t.clientY - g.y0;
    if (!g.active) {
      if (dx > 12 && Math.abs(dx) > Math.abs(dy) * RATIO) {
        g.active = true;
        el.viewChat.classList.add("dragging");
      } else if (Math.abs(dy) > 14) { g = null; return; }
    }
    if (g.active) {
      g.dx = Math.max(0, dx);
      el.viewChat.style.transform = `translateX(${g.dx}px)`;
    }
  }, { passive: true });

  function finish(cancelled) {
    if (!g) return;
    const wasActive = g.active, dx = g.dx;
    const dt = Date.now() - g.t0;
    g = null;
    if (!wasActive) return;
    el.viewChat.classList.remove("dragging");
    const fast = dx > 40 && dt < 260;
    if (!cancelled && (dx > DIST || fast)) {
      el.viewChat.classList.add("slide-out");
      el.viewChat.style.transform = "translateX(100%)";
      setTimeout(() => {
        el.viewChat.classList.remove("slide-out");
        showList();
      }, 210);
    } else {
      el.viewChat.classList.add("snap-back");
      el.viewChat.style.transform = "";
      setTimeout(() => el.viewChat.classList.remove("snap-back"), 260);
    }
  }
  el.viewChat.addEventListener("touchend", () => finish(false));
  el.viewChat.addEventListener("touchcancel", () => finish(true));
})();

// ===========================================================================
// 首次啟動導覽
// ===========================================================================

const ONBOARDING_COPY = {
  en: {
    guideTitle: "Setup guide", guideSubtitle: "Review the essentials for this device", language: "Language", appearance: "Appearance", back: "Back", skip: "Skip", next: "Continue", finish: "Start using Pi Harbor",
    steps: [
      { eyebrow: "WELCOME", title: "Welcome aboard", body: "Pi Harbor gives your local Pi Agent a calm, focused home on desktop and mobile.", points: ["Choose your language and appearance now; both can be changed later.", "Ink & Ivory is the default Pi Harbor theme."] },
      { eyebrow: "LOCAL FIRST", title: "Your computer stays in charge", body: "Pi Harbor is an interface for the Pi Agent installed on this computer. Sessions, credentials, and project files remain on the host.", points: ["Pi Harbor listens on this computer and does not move your projects to a hosted cloud.", "Every additional computer needs its own Pi Harbor installation."] },
      { eyebrow: "MAKE IT YOURS", title: "Models and projects", body: "Add a provider or sign in to an account from Settings, then choose a project folder to start a session.", points: ["Models & providers keeps services and model visibility in one place.", "New project can open your home folder or an allowed external drive."] },
      { eyebrow: "REMOTE ACCESS", title: "Connect securely", body: "For another computer or phone, keep the Node service on loopback and open Pi Harbor through a private HTTPS address such as Tailscale Serve.", points: ["Use the same Web token when pairing Pi Harbor computers.", "Never expose port 3140 directly to an untrusted network."] },
    ],
  },
  "zh-Hans": {
    guideTitle: "设置导览", guideSubtitle: "重新查看这台设备的基本设置", language: "语言", appearance: "外观", back: "返回", skip: "跳过", next: "继续", finish: "开始使用 Pi Harbor",
    steps: [
      { eyebrow: "欢迎", title: "欢迎登船", body: "Pi Harbor 为本机的 Pi Agent 提供一个简洁、专注，并同时适合电脑与手机的操作界面。", points: ["先选择语言与外观，之后仍可随时更改。", "Pi Harbor 默认使用 Ink & Ivory 主题。"] },
      { eyebrow: "本机优先", title: "电脑仍是核心", body: "Pi Harbor 是这台电脑上 Pi Agent 的操作界面。工作阶段、凭证与项目文件都会留在主机上。", points: ["Pi Harbor 不会把你的项目搬到托管云端。", "每一台要使用的电脑都需要各自安装 Pi Harbor。"] },
      { eyebrow: "开始配置", title: "模型与项目", body: "在设置中添加 Provider 或登录账号，然后选择项目文件夹来开始工作阶段。", points: ["“模型与 Provider”会集中管理服务与模型显示。", "“新建项目”可以打开主文件夹或允许访问的外接硬盘。"] },
      { eyebrow: "远程访问", title: "安全连接", body: "要从其他电脑或手机使用，请让 Node 服务只监听本机，并通过 Tailscale Serve 等私有 HTTPS 地址打开 Pi Harbor。", points: ["配对多台 Pi Harbor 电脑时使用同一个 Web token。", "不要把 3140 端口直接开放到不受信任的网络。"] },
    ],
  },
  "zh-Hant": {
    guideTitle: "設定導覽", guideSubtitle: "重新查看這台裝置的基本設定", language: "語言", appearance: "外觀", back: "返回", skip: "略過", next: "繼續", finish: "開始使用 Pi Harbor",
    steps: [
      { eyebrow: "歡迎", title: "歡迎登船", body: "Pi Harbor 為本機的 Pi Agent 提供一個簡潔、專注，並同時適合電腦與手機的操作介面。", points: ["先選擇語言與外觀，之後仍可隨時更改。", "Pi Harbor 預設使用 Ink & Ivory 主題。"] },
      { eyebrow: "本機優先", title: "電腦仍是核心", body: "Pi Harbor 是這台電腦上 Pi Agent 的操作介面。工作階段、憑證與專案檔案都會留在主機上。", points: ["Pi Harbor 不會把你的專案搬到託管雲端。", "每一台要使用的電腦都需要各自安裝 Pi Harbor。"] },
      { eyebrow: "開始設定", title: "模型與專案", body: "在設定中加入 Provider 或登入帳號，然後選擇專案資料夾來開始工作階段。", points: ["「模型與 Provider」會集中管理服務與模型顯示。", "「新增專案」可以開啟家目錄或允許存取的外接硬碟。"] },
      { eyebrow: "遠端存取", title: "安全連線", body: "要從其他電腦或手機使用，請讓 Node 服務只監聽本機，並透過 Tailscale Serve 等私有 HTTPS 位址開啟 Pi Harbor。", points: ["配對多台 Pi Harbor 電腦時使用同一個 Web token。", "不要把 3140 port 直接開放到不受信任的網路。"] },
    ],
  },
  ja: {
    guideTitle: "セットアップガイド", guideSubtitle: "このデバイスの基本設定を確認", language: "言語", appearance: "外観", back: "戻る", skip: "スキップ", next: "次へ", finish: "Pi Harbor を使い始める",
    steps: [
      { eyebrow: "ようこそ", title: "Pi Harbor へようこそ", body: "Pi Harbor は、このMac上の Pi Agent をデスクトップでもモバイルでも快適に操作できる、落ち着いたインターフェイスです。", points: ["言語と外観は後からいつでも変更できます。", "既定のテーマは Ink & Ivory です。"] },
      { eyebrow: "ローカル優先", title: "主役はこのコンピュータ", body: "Pi Harbor はこのコンピュータにある Pi Agent の操作画面です。セッション、認証情報、プロジェクトファイルはホストに残ります。", points: ["プロジェクトを外部のホスティング環境へ移動しません。", "利用する各コンピュータに Pi Harbor のインストールが必要です。"] },
      { eyebrow: "準備", title: "モデルとプロジェクト", body: "設定からプロバイダーを追加するかアカウントにサインインし、プロジェクトフォルダを選んでセッションを始めます。", points: ["モデルとプロバイダーは一つの画面で管理できます。", "新規プロジェクトからホームまたは許可済みの外部ドライブを開けます。"] },
      { eyebrow: "リモートアクセス", title: "安全に接続", body: "別のコンピュータやスマートフォンから使う場合は、Node サービスをループバックのままにし、Tailscale Serve などのプライベート HTTPS 経由で開きます。", points: ["複数の端末をペアリングするときは同じ Web トークンを使います。", "ポート 3140 を信頼できないネットワークへ直接公開しないでください。"] },
    ],
  },
  ko: {
    guideTitle: "설정 안내", guideSubtitle: "이 기기의 기본 설정 다시 보기", language: "언어", appearance: "화면 모드", back: "뒤로", skip: "건너뛰기", next: "계속", finish: "Pi Harbor 시작하기",
    steps: [
      { eyebrow: "환영합니다", title: "Pi Harbor에 오신 것을 환영합니다", body: "Pi Harbor는 이 컴퓨터의 Pi Agent를 데스크톱과 모바일에서 편안하게 사용할 수 있는 깔끔한 인터페이스입니다.", points: ["언어와 화면 모드는 나중에도 언제든 바꿀 수 있습니다.", "기본 테마는 Ink & Ivory입니다."] },
      { eyebrow: "로컬 우선", title: "컴퓨터가 중심입니다", body: "Pi Harbor는 이 컴퓨터에 설치된 Pi Agent의 인터페이스입니다. 세션, 자격 증명, 프로젝트 파일은 호스트에 남습니다.", points: ["프로젝트를 외부 호스팅 클라우드로 옮기지 않습니다.", "사용할 컴퓨터마다 Pi Harbor를 설치해야 합니다."] },
      { eyebrow: "설정", title: "모델과 프로젝트", body: "설정에서 제공자를 추가하거나 계정에 로그인한 뒤 프로젝트 폴더를 선택해 세션을 시작하세요.", points: ["모델 및 제공자 화면에서 서비스와 모델 표시 여부를 함께 관리합니다.", "새 프로젝트에서 홈 폴더 또는 허용된 외장 드라이브를 열 수 있습니다."] },
      { eyebrow: "원격 접속", title: "안전하게 연결하세요", body: "다른 컴퓨터나 휴대폰에서 사용할 때는 Node 서비스를 로컬에만 두고 Tailscale Serve 같은 비공개 HTTPS 주소로 Pi Harbor를 여세요.", points: ["여러 Pi Harbor 컴퓨터를 연결할 때 같은 Web 토큰을 사용합니다.", "3140 포트를 신뢰할 수 없는 네트워크에 직접 공개하지 마세요."] },
    ],
  },
};

const ONBOARDING_LANGUAGE_LABELS = {
  en: ["English", "Chinese (Simplified)", "Chinese (Traditional)", "Japanese", "Korean", "Turkish", "French", "German", "Spanish", "Portuguese (Brazil)", "Italian"],
  "zh-Hans": ["英语", "简体中文", "繁体中文", "日语", "韩语", "土耳其语", "法语", "德语", "西班牙语", "葡萄牙语（巴西）", "意大利语"],
  "zh-Hant": ["英文", "簡體中文", "繁體中文", "日文", "韓文", "土耳其文", "法文", "德文", "西班牙文", "葡萄牙文（巴西）", "義大利文"],
  ja: ["英語", "簡体字中国語", "繁体字中国語", "日本語", "韓国語", "トルコ語", "フランス語", "ドイツ語", "スペイン語", "ポルトガル語（ブラジル）", "イタリア語"],
  ko: ["영어", "중국어 간체", "중국어 번체", "일본어", "한국어", "튀르키예어", "프랑스어", "독일어", "스페인어", "포르투갈어(브라질)", "이탈리아어"],
};

const ONBOARDING_EUROPEAN = {
  tr: ["Kurulum rehberi", "Bu cihazın temel ayarlarını yeniden gözden geçirin", "Dil", "Görünüm", "Geri", "Atla", "Devam", "Pi Harbor'ı kullanmaya başla", [
    ["HOŞ GELDİNİZ", "Pi Harbor'a hoş geldiniz", "Pi Harbor, bu bilgisayardaki Pi Agent için masaüstü ve mobilde sade, odaklı bir arayüz sunar.", "Dil ve görünümü daha sonra değiştirebilirsiniz.", "Varsayılan tema Ink & Ivory'dir."],
    ["ÖNCE YEREL", "Kontrol bilgisayarınızda", "Pi Harbor bu bilgisayardaki Pi Agent'ın arayüzüdür. Oturumlar, kimlik bilgileri ve proje dosyaları ana bilgisayarda kalır.", "Projeleriniz barındırılan bir buluta taşınmaz.", "Kullanacağınız her bilgisayara Pi Harbor kurulmalıdır."],
    ["HAZIRLIK", "Modeller ve projeler", "Ayarlar'dan bir sağlayıcı ekleyin veya oturum açın; ardından bir proje klasörü seçerek oturum başlatın.", "Modeller ve sağlayıcılar tek yerde yönetilir.", "Yeni proje, ana klasörü veya izin verilen harici diski açabilir."],
    ["UZAKTAN ERİŞİM", "Güvenli bağlanın", "Başka bir bilgisayar veya telefondan kullanmak için Node hizmetini yerel döngüde tutun ve Pi Harbor'ı Tailscale Serve gibi özel bir HTTPS adresiyle açın.", "Cihazları eşlerken aynı Web belirtecini kullanın.", "3140 numaralı bağlantı noktasını güvenilmeyen bir ağa doğrudan açmayın."],
  ]],
  fr: ["Guide de configuration", "Revoir les réglages essentiels de cet appareil", "Langue", "Apparence", "Retour", "Ignorer", "Continuer", "Commencer avec Pi Harbor", [
    ["BIENVENUE", "Bienvenue à bord", "Pi Harbor offre à l’agent Pi de cet ordinateur une interface claire et sereine, sur ordinateur comme sur mobile.", "Vous pourrez modifier la langue et l’apparence à tout moment.", "Ink & Ivory est le thème par défaut."],
    ["LOCAL D’ABORD", "Votre ordinateur garde le contrôle", "Pi Harbor est l’interface de l’agent Pi installé sur cet ordinateur. Les sessions, identifiants et fichiers de projet restent sur l’hôte.", "Vos projets ne sont pas déplacés vers un cloud hébergé.", "Chaque ordinateur utilisé doit avoir sa propre installation de Pi Harbor."],
    ["CONFIGURATION", "Modèles et projets", "Ajoutez un fournisseur ou connectez un compte dans Réglages, puis choisissez un dossier de projet pour démarrer une session.", "Modèles et fournisseurs sont gérés au même endroit.", "Nouveau projet peut ouvrir votre dossier personnel ou un disque externe autorisé."],
    ["ACCÈS À DISTANCE", "Connectez-vous en toute sécurité", "Depuis un autre ordinateur ou téléphone, laissez le service Node sur l’interface locale et ouvrez Pi Harbor via une adresse HTTPS privée, telle que Tailscale Serve.", "Utilisez le même jeton Web pour associer plusieurs ordinateurs.", "N’exposez jamais directement le port 3140 à un réseau non fiable."],
  ]],
  de: ["Einrichtungsassistent", "Grundeinstellungen dieses Geräts erneut ansehen", "Sprache", "Darstellung", "Zurück", "Überspringen", "Weiter", "Pi Harbor verwenden", [
    ["WILLKOMMEN", "Willkommen an Bord", "Pi Harbor gibt dem Pi Agent auf diesem Computer eine ruhige, übersichtliche Oberfläche für Desktop und Mobilgeräte.", "Sprache und Darstellung lassen sich später jederzeit ändern.", "Ink & Ivory ist das Standarddesign."],
    ["LOKAL ZUERST", "Ihr Computer behält die Kontrolle", "Pi Harbor ist die Oberfläche für den Pi Agent auf diesem Computer. Sitzungen, Zugangsdaten und Projektdateien bleiben auf dem Host.", "Ihre Projekte werden nicht in eine gehostete Cloud verschoben.", "Auf jedem verwendeten Computer muss Pi Harbor installiert sein."],
    ["EINRICHTUNG", "Modelle und Projekte", "Fügen Sie unter Einstellungen einen Anbieter hinzu oder melden Sie sich an. Wählen Sie danach einen Projektordner für die erste Sitzung.", "Modelle und Anbieter werden an einer Stelle verwaltet.", "Neues Projekt kann den Benutzerordner oder ein freigegebenes externes Laufwerk öffnen."],
    ["FERNZUGRIFF", "Sicher verbinden", "Für den Zugriff von einem anderen Computer oder Smartphone bleibt der Node-Dienst lokal gebunden. Öffnen Sie Pi Harbor über eine private HTTPS-Adresse wie Tailscale Serve.", "Verwenden Sie beim Koppeln denselben Web-Token.", "Geben Sie Port 3140 nie direkt in einem nicht vertrauenswürdigen Netzwerk frei."],
  ]],
  es: ["Guía de configuración", "Repasa los ajustes esenciales de este dispositivo", "Idioma", "Apariencia", "Atrás", "Omitir", "Continuar", "Empezar a usar Pi Harbor", [
    ["BIENVENIDA", "Bienvenido a bordo", "Pi Harbor ofrece al agente Pi de este ordenador una interfaz tranquila y clara tanto en el escritorio como en el móvil.", "Puedes cambiar el idioma y la apariencia en cualquier momento.", "Ink & Ivory es el tema predeterminado."],
    ["PRIMERO, LOCAL", "Tu ordenador mantiene el control", "Pi Harbor es la interfaz del agente Pi instalado en este ordenador. Las sesiones, credenciales y archivos de proyecto permanecen en el equipo anfitrión.", "Tus proyectos no se trasladan a una nube alojada.", "Cada ordenador que uses necesita su propia instalación de Pi Harbor."],
    ["CONFIGURACIÓN", "Modelos y proyectos", "Añade un proveedor o inicia sesión desde Ajustes y elige una carpeta de proyecto para comenzar una sesión.", "Los modelos y proveedores se administran en un mismo lugar.", "Nuevo proyecto puede abrir tu carpeta personal o una unidad externa autorizada."],
    ["ACCESO REMOTO", "Conéctate de forma segura", "Para usar otro ordenador o teléfono, mantén el servicio Node en la interfaz local y abre Pi Harbor mediante una dirección HTTPS privada, como Tailscale Serve.", "Usa el mismo token web al emparejar varios ordenadores.", "No expongas el puerto 3140 directamente a una red que no sea de confianza."],
  ]],
  "pt-BR": ["Guia de configuração", "Revise as configurações essenciais deste dispositivo", "Idioma", "Aparência", "Voltar", "Pular", "Continuar", "Começar a usar o Pi Harbor", [
    ["BOAS-VINDAS", "Bem-vindo a bordo", "O Pi Harbor oferece ao Pi Agent deste computador uma interface limpa e tranquila no desktop e no celular.", "Idioma e aparência podem ser alterados a qualquer momento.", "Ink & Ivory é o tema padrão."],
    ["LOCAL PRIMEIRO", "Seu computador continua no controle", "O Pi Harbor é a interface do Pi Agent instalado neste computador. Sessões, credenciais e arquivos de projeto permanecem no host.", "Seus projetos não são enviados para uma nuvem hospedada.", "Cada computador usado precisa da própria instalação do Pi Harbor."],
    ["CONFIGURAÇÃO", "Modelos e projetos", "Adicione um provedor ou entre em uma conta nos Ajustes e escolha uma pasta de projeto para iniciar uma sessão.", "Modelos e provedores ficam reunidos em um só lugar.", "Novo projeto pode abrir sua pasta pessoal ou uma unidade externa permitida."],
    ["ACESSO REMOTO", "Conecte-se com segurança", "Em outro computador ou celular, mantenha o serviço Node restrito ao endereço local e abra o Pi Harbor por um endereço HTTPS privado, como o Tailscale Serve.", "Use o mesmo token Web ao parear computadores.", "Não exponha a porta 3140 diretamente a uma rede não confiável."],
  ]],
  it: ["Guida alla configurazione", "Rivedi le impostazioni essenziali di questo dispositivo", "Lingua", "Aspetto", "Indietro", "Salta", "Continua", "Inizia a usare Pi Harbor", [
    ["BENVENUTO", "Benvenuto a bordo", "Pi Harbor offre al Pi Agent di questo computer un’interfaccia ordinata e tranquilla, sia su desktop sia su dispositivi mobili.", "Lingua e aspetto possono essere modificati in qualsiasi momento.", "Ink & Ivory è il tema predefinito."],
    ["PRIMA IL LOCALE", "Il computer mantiene il controllo", "Pi Harbor è l’interfaccia del Pi Agent installato su questo computer. Sessioni, credenziali e file di progetto restano sull’host.", "I progetti non vengono trasferiti in un cloud ospitato.", "Ogni computer utilizzato deve avere la propria installazione di Pi Harbor."],
    ["CONFIGURAZIONE", "Modelli e progetti", "Aggiungi un provider o accedi a un account dalle Impostazioni, poi scegli una cartella di progetto per avviare una sessione.", "Modelli e provider vengono gestiti in un unico punto.", "Nuovo progetto può aprire la cartella personale o un’unità esterna autorizzata."],
    ["ACCESSO REMOTO", "Connettiti in sicurezza", "Da un altro computer o telefono, mantieni il servizio Node sull’interfaccia locale e apri Pi Harbor tramite un indirizzo HTTPS privato, come Tailscale Serve.", "Usa lo stesso token Web quando abbini più computer.", "Non esporre direttamente la porta 3140 a una rete non attendibile."],
  ]],
};

for (const [locale, values] of Object.entries(ONBOARDING_EUROPEAN)) {
  const [guideTitle, guideSubtitle, language, appearance, back, skip, next, finish, rawSteps] = values;
  ONBOARDING_COPY[locale] = { guideTitle, guideSubtitle, language, appearance, back, skip, next, finish, steps: rawSteps.map(([eyebrow, title, body, first, second]) => ({ eyebrow, title, body, points: [first, second] })) };
}

function onboardingCopy() {
  return ONBOARDING_COPY[settings.locale] || ONBOARDING_COPY.en;
}

function renderOnboarding() {
  if (!el.onboarding) return;
  const copy = onboardingCopy();
  const step = copy.steps[onboardingStep] || copy.steps[0];
  el.onboardingEyebrow.textContent = step.eyebrow;
  el.onboardingTitle.textContent = step.title;
  el.onboardingBody.textContent = step.body;
  el.onboardingPoints.innerHTML = "";
  for (const point of step.points) {
    const item = document.createElement("li");
    item.textContent = point;
    el.onboardingPoints.appendChild(item);
  }
  el.onboardingProgress.forEach((item, index) => item.classList.toggle("active", index <= onboardingStep));
  el.onboardingPreferences.classList.toggle("hidden", onboardingStep !== 0);
  el.onboardingBack.classList.toggle("hidden", onboardingStep === 0);
  el.onboardingBack.textContent = copy.back;
  el.onboardingSkip.textContent = copy.skip;
  el.onboardingNext.textContent = onboardingStep === copy.steps.length - 1 ? copy.finish : copy.next;
  el.onboardingLanguageLabel.textContent = copy.language;
  el.onboardingAppearanceLabel.textContent = copy.appearance;
  if (el.setupGuideTitle) el.setupGuideTitle.textContent = copy.guideTitle;
  if (el.setupGuideSubtitle) el.setupGuideSubtitle.textContent = copy.guideSubtitle;
  el.onboardingLanguage.value = settings.locale;
  const languageLabels = ONBOARDING_LANGUAGE_LABELS[settings.locale] || ONBOARDING_LANGUAGE_LABELS.en;
  [...el.onboardingLanguage.options].forEach((option, index) => { option.textContent = languageLabels[index] || option.textContent; });
  el.onboardingAppearance.value = settings.theme;
  for (const option of el.onboardingAppearance.options) option.textContent = window.piI18n?.t(option.value === "auto" ? "System" : option.value === "light" ? "Light" : "Dark") || option.textContent;
}

function completeOnboarding() {
  try { localStorage.setItem(ONBOARDING_KEY, "complete"); } catch {}
  el.onboarding?.classList.add("hidden");
}

function openOnboarding(force = false) {
  if (!el.onboarding) return;
  if (!force) {
    try { if (localStorage.getItem(ONBOARDING_KEY) === "complete") return; } catch {}
  }
  onboardingStep = 0;
  if (!el.onboardingLanguage.options.length) {
    for (const locale of window.piI18n?.locales || [{ id: "en", label: "English" }]) {
      const option = document.createElement("option");
      option.value = locale.id;
      option.textContent = locale.label;
      el.onboardingLanguage.appendChild(option);
    }
  }
  renderOnboarding();
  el.onboarding.classList.remove("hidden");
}

el.btnOpenOnboarding?.addEventListener("click", () => openOnboarding(true));
el.onboardingClose?.addEventListener("click", completeOnboarding);
el.onboardingSkip?.addEventListener("click", completeOnboarding);
el.onboardingBack?.addEventListener("click", () => { onboardingStep = Math.max(0, onboardingStep - 1); renderOnboarding(); });
el.onboardingNext?.addEventListener("click", () => {
  if (onboardingStep >= onboardingCopy().steps.length - 1) { completeOnboarding(); return; }
  onboardingStep += 1;
  renderOnboarding();
});
el.onboardingLanguage?.addEventListener("change", () => {
  settings = saveSettings({ locale: window.piI18n?.normalizeLocale(el.onboardingLanguage.value) || "en" });
  window.piI18n?.setLocale(settings.locale);
  renderOnboarding();
  renderSettings();
});
el.onboardingAppearance?.addEventListener("change", () => {
  settings = saveSettings({ theme: el.onboardingAppearance.value });
  applyAppearance();
  renderOnboarding();
});

// ===========================================================================
// 設定頁
// ===========================================================================

function renderThemeChoices() {
  if (!el.setDesignTheme) return;
  el.setDesignTheme.innerHTML = "";
  for (const theme of DESIGN_THEMES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "theme-choice" + (settings.designTheme === theme.id ? " selected" : "");
    button.dataset.theme = theme.id;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(settings.designTheme === theme.id));
    button.setAttribute("aria-label", theme.label);
    const swatches = document.createElement("span");
    swatches.className = "theme-swatches";
    const light = document.createElement("i"); light.className = "theme-swatch light";
    const dark = document.createElement("i"); dark.className = "theme-swatch dark";
    swatches.append(light, dark);
    const label = document.createElement("strong"); label.textContent = theme.label;
    const check = document.createElement("span"); check.className = "theme-choice-check"; check.textContent = "✓";
    button.append(swatches, label, check);
    el.setDesignTheme.appendChild(button);
  }
}

let updateStatusData = null;
let updateStatusRequest = 0;

function renderUpdateStatus(data = updateStatusData) {
  const updater = data?.updater;
  if (!el.setAutoUpdate || !el.updateStatusCopy || !el.updateCheckStatus) return;
  if (!updater) {
    el.setAutoUpdate.checked = false;
    el.setAutoUpdate.disabled = true;
    el.updateCheck.disabled = true;
    el.updateStatusCopy.textContent = "Update status is unavailable on this Pi Harbor device";
    el.updateCheckStatus.textContent = "Updater status unavailable";
    return;
  }
  const installed = updater.installed === true;
  el.setAutoUpdate.checked = updater.enabled === true;
  el.setAutoUpdate.disabled = !installed;
  el.updateCheck.disabled = !installed;
  if (!installed) {
    el.updateStatusCopy.textContent = "Install the Pi Harbor updater service to enable automatic updates";
    el.updateCheckStatus.textContent = "Updater service not installed";
    return;
  }
  el.updateStatusCopy.textContent = updater.enabled
    ? `Checks GitHub every ${updater.intervalMinutes || 60} minutes`
    : "Automatic updates are off on this device";
  if (updater.error) {
    el.updateCheckStatus.textContent = `Last check failed: ${updater.error}`;
  } else if (updater.latestSha && updater.currentSha && updater.latestSha !== updater.currentSha) {
    el.updateCheckStatus.textContent = updater.latestVersion
      ? `Update available: Pi Harbor ${updater.latestVersion}`
      : "Update available from GitHub";
  } else if (updater.lastCheckedAt) {
    el.updateCheckStatus.textContent = `Up to date · checked ${new Date(updater.lastCheckedAt).toLocaleString()}`;
  } else {
    el.updateCheckStatus.textContent = "Ready to check GitHub";
  }
}

async function loadUpdateStatus() {
  const request = ++updateStatusRequest;
  try {
    const data = await api("/api/update/status");
    if (request !== updateStatusRequest) return;
    updateStatusData = data;
    renderUpdateStatus(data);
  } catch (error) {
    if (request !== updateStatusRequest) return;
    updateStatusData = null;
    renderUpdateStatus(null);
    if (el.updateCheckStatus) el.updateCheckStatus.textContent = error.status === 404 ? "Update controls require a newer Pi Harbor" : "Updater status unavailable";
  }
}

async function saveAutomaticUpdates(enabled) {
  if (!el.setAutoUpdate) return;
  el.setAutoUpdate.disabled = true;
  try {
    updateStatusData = await post("/api/update/settings", { enabled });
    renderUpdateStatus(updateStatusData);
    toast(enabled ? "Automatic updates enabled" : "Automatic updates disabled");
  } catch (error) {
    renderUpdateStatus(updateStatusData);
    toast(error.message || "Could not save update settings", true);
  }
}

async function runUpdateCheck() {
  if (!el.updateCheck) return;
  el.updateCheck.disabled = true;
  if (el.updateCheckStatus) el.updateCheckStatus.textContent = "Checking GitHub…";
  try {
    await post("/api/update/run", {});
    toast("Update check started");
    setTimeout(() => void loadUpdateStatus(), 2500);
  } catch (error) {
    renderUpdateStatus(updateStatusData);
    toast(error.message || "Could not start update check", true);
  }
}

function renderSettings() {
  const selectedMachine = currentMachine();
  el.setMachineName.textContent = machineDisplayName(selectedMachine) || machineDisplayName(currentHost) || "—";
  el.setMachineHost.textContent = machineDisplayHost(selectedMachine) || "—";
  el.setPiVersion.textContent = window._piVersion || "…";
  el.setSessionCount.textContent = String(sessionsCache.length);
  if (el.setLocale) el.setLocale.value = settings.locale || "en";
  el.setTheme.value = settings.theme;
  renderThemeChoices();
  if (el.setSidebarWidth) el.setSidebarWidth.value = settings.sidebarWidth;
  if (el.setSidebarWidthValue) el.setSidebarWidthValue.textContent = `${settings.sidebarWidth}px`;
  if (el.setFontScale) el.setFontScale.value = settings.fontScale;
  if (el.setFontScaleValue) el.setFontScaleValue.textContent = `${settings.fontScale}%`;
  el.setCompact.checked = !!settings.compact;
  el.setGroup.checked = !!settings.groupByProject;
  el.setReducedMotion.checked = !!settings.reducedMotion;
  el.setThinking.value = settings.thinking;
  const setupCopy = onboardingCopy();
  if (el.setupGuideTitle) el.setupGuideTitle.textContent = setupCopy.guideTitle;
  if (el.setupGuideSubtitle) el.setupGuideSubtitle.textContent = setupCopy.guideSubtitle;
  renderMachineList();
  void refreshMachineStatuses();
  renderUpdateStatus();
  void loadUpdateStatus();
}

function modelMachineKey() { return selectedId || selfId || "local"; }
/*
 * Model visibility is stored per machine, but the machine id is not known at
 * first paint: /api/machines has to answer first, so modelMachineKey() falls
 * back to "local" until then. Anything saved during that window lands under a
 * key the app stops reading once the real id arrives, which reads to a user as
 * "my checkboxes reset themselves". The same happens the other way when a
 * device is later renamed or paired, moving it from a synthetic id to a
 * persisted one.
 *
 * Rather than trust one key, resolve visibility against every key that can
 * legitimately name THIS device, newest-first, and migrate the first match
 * onto the current key as soon as one exists. Reading stays tolerant, writing
 * stays single-keyed, and the stale entry is dropped once it has been moved.
 */
function modelMachineKeyCandidates() {
  const keys = [];
  const push = (value) => {
    if (typeof value === "string" && value && !keys.includes(value)) keys.push(value);
  };
  push(selectedId);
  push(selfId);
  push("local");
  return keys;
}

/**
 * The key whose hidden-model list should be treated as authoritative right now:
 * the current key when it already holds data, otherwise the first fallback that
 * does. Returns the current key when nothing is stored yet.
 */
function resolvedModelVisibilityKey(map, machine = modelMachineKey()) {
  const source = map && typeof map === "object" ? map : {};
  if (Array.isArray(source[machine]) && source[machine].length) return machine;
  for (const key of modelMachineKeyCandidates()) {
    if (Array.isArray(source[key]) && source[key].length) return key;
  }
  return machine;
}
function modelVisibilityKey(model) {
  return `${model?.provider || "unknown"}::${model?.id || ""}`;
}
function hiddenModelSet(machine = modelMachineKey()) {
  const map = settings.modelVisibility && typeof settings.modelVisibility === "object" ? settings.modelVisibility : {};
  const key = resolvedModelVisibilityKey(map, machine);
  return new Set(Array.isArray(map[key]) ? map[key] : []);
}
function isModelVisible(model) { return !hiddenModelSet().has(modelVisibilityKey(model)); }
function setModelVisible(model, visible) {
  const machine = modelMachineKey();
  const map = settings.modelVisibility && typeof settings.modelVisibility === "object"
    ? { ...settings.modelVisibility } : {};
  // Writing always targets the current key, so a rename/pair carries the list
  // forward instead of leaving two half-truths behind.
  const resolved = resolvedModelVisibilityKey(map, machine);
  if (resolved !== machine) delete map[resolved];
  const hidden = hiddenModelSet(machine);
  const key = modelVisibilityKey(model);
  if (visible) hidden.delete(key); else hidden.add(key);
  if (hidden.size) map[machine] = [...hidden];
  else delete map[machine];
  settings = saveSettings({ modelVisibility: map });
}

let modelProviderError = "";
let modelProviderNotice = "";

function renderModelSettingsSummary() {
  if (!el.modelSettingsSummary) return;
  if (modelCatalogLoading && modelCatalogMachine == null) {
    el.modelSettingsSummary.textContent = "讀取模型與 Provider…";
    return;
  }
  const providers = new Set(modelCatalog.map((model) => model?.provider || "unknown"));
  const modelKeys = new Set(modelCatalog.map((model) => `${model?.provider || "unknown"}::${model?.id || ""}`));
  for (const provider of configuredProviders) {
    providers.add(provider.id);
    for (const model of provider.models || []) modelKeys.add(`${provider.id}::${model.id}`);
  }
  const suffix = modelProviderError ? " · 設定需檢查" : "";
  el.modelSettingsSummary.textContent = providers.size || modelKeys.size
    ? `${providers.size} Provider · ${modelKeys.size} 模型${suffix}`
    : `管理模型顯示與自訂 Provider${suffix}`;
}

function providerModelLines(provider) {
  return Array.isArray(provider?.models)
    ? provider.models.map((model) => `${model.id}${model.name && model.name !== model.id ? ` | ${model.name}` : ""}`).join("\n")
    : "";
}

function renderModelVisibility() {
  if (!el.modelVisibilityList) return;
  el.modelVisibilityList.innerHTML = "";
  const groups = new Map();
  const addModel = (provider, model) => {
    if (!provider || !model?.id) return;
    if (!groups.has(provider)) groups.set(provider, []);
    const models = groups.get(provider);
    if (!models.some((item) => item.id === model.id)) models.push({ ...model, provider });
  };
  for (const model of modelCatalog) addModel(model.provider || "unknown", model);
  for (const provider of configuredProviders) {
    for (const model of provider.models || []) addModel(provider.id, { ...model, configuredOnly: true });
    if (!groups.has(provider.id)) groups.set(provider.id, []);
  }

  const query = String(el.modelFilter?.value || "").trim().toLocaleLowerCase();
  const configured = new Map(configuredProviders.map((provider) => [provider.id, provider]));
  let totalModels = 0;
  let shownModels = 0;
  let shownProviders = 0;
  if (modelProviderNotice) {
    const notice = document.createElement("p");
    notice.className = "settings-note model-provider-warning";
    notice.textContent = modelProviderNotice;
    el.modelVisibilityList.appendChild(notice);
  }
  if (modelProviderError) {
    const warning = document.createElement("p");
    warning.className = "settings-note model-provider-warning error-text";
    warning.textContent = `Provider 設定讀取失敗：${modelProviderError}`;
    el.modelVisibilityList.appendChild(warning);
  }

  for (const [provider, models] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    totalModels += models.length;
    const providerMatch = !query || provider.toLocaleLowerCase().includes(query);
    const visibleModels = providerMatch ? models : models.filter((model) =>
      `${model.name || ""} ${model.id || ""}`.toLocaleLowerCase().includes(query));
    if (query && !providerMatch && !visibleModels.length) continue;
    shownProviders++;
    shownModels += visibleModels.length;

    const group = document.createElement("section");
    const expanded = !!query || expandedModelProviders.has(provider);
    group.className = "model-provider-group" + (expanded ? " expanded" : " collapsed");
    const heading = document.createElement("div");
    heading.className = "model-provider-heading";
    const headingToggle = document.createElement("button");
    headingToggle.type = "button";
    headingToggle.className = "model-provider-toggle";
    headingToggle.dataset.modelProviderToggle = provider;
    headingToggle.setAttribute("aria-expanded", String(expanded));
    headingToggle.setAttribute("aria-label", `${expanded ? "收起" : "展開"} ${provider} 模型`);
    const headingCopy = document.createElement("div");
    headingCopy.className = "model-provider-heading-copy";
    const providerName = document.createElement("strong");
    providerName.textContent = provider;
    const meta = document.createElement("span");
    const providerConfig = configured.get(provider);
    const visible = models.filter(isModelVisible).length;
    meta.textContent = `${visible}/${models.length}${providerConfig ? " · 自訂" : ""}`;
    headingCopy.append(providerName, meta);
    const chevron = document.createElement("span");
    chevron.className = "model-provider-chevron";
    chevron.textContent = "⌄";
    headingToggle.append(headingCopy, chevron);
    heading.appendChild(headingToggle);
    if (providerConfig) {
      const actions = document.createElement("div");
      actions.className = "model-provider-actions";
      const edit = document.createElement("button");
      edit.type = "button"; edit.className = "icon-button-small provider-action";
      edit.dataset.providerAction = "edit"; edit.dataset.providerId = provider;
      edit.title = `編輯 ${provider}`; edit.setAttribute("aria-label", `編輯 ${provider}`);
      edit.innerHTML = '<svg class="icon"><use href="#i-pencil"></use></svg>';
      const remove = document.createElement("button");
      remove.type = "button"; remove.className = "icon-button-small provider-action danger-text";
      remove.dataset.providerAction = "delete"; remove.dataset.providerId = provider;
      remove.title = `刪除 ${provider}`; remove.setAttribute("aria-label", `刪除 ${provider}`);
      remove.innerHTML = '<svg class="icon"><use href="#i-x"></use></svg>';
      actions.append(edit, remove);
      heading.appendChild(actions);
    }
    group.appendChild(heading);
    for (const model of visibleModels) {
      const row = document.createElement("label");
      row.className = "model-visibility-row" + (model.configuredOnly ? " configured-only" : "");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = isModelVisible(model);
      checkbox.addEventListener("change", () => {
        setModelVisible(model, checkbox.checked);
        meta.textContent = `${models.filter(isModelVisible).length}/${models.length}${providerConfig ? " · 自訂" : ""}`;
      });
      const copy = document.createElement("span");
      copy.className = "model-visibility-copy";
      const name = document.createElement("strong");
      name.textContent = model.name || model.id;
      const id = document.createElement("small");
      id.textContent = model.configuredOnly ? `${model.id} · 尚未載入` : model.id;
      copy.append(name, id);
      row.append(checkbox, copy);
      group.appendChild(row);
    }
    el.modelVisibilityList.appendChild(group);
  }

  if (!groups.size) {
    const empty = document.createElement("p");
    empty.className = "settings-note model-visibility-empty";
    empty.textContent = modelProviderError ? "請修正 models.json 後重新讀取。" : "沒有讀到可用模型，點右上角重新讀取。";
    el.modelVisibilityList.appendChild(empty);
  } else if (query && !shownProviders) {
    const empty = document.createElement("p");
    empty.className = "settings-note model-visibility-empty";
    empty.textContent = "找不到符合的 Provider 或模型。";
    el.modelVisibilityList.appendChild(empty);
  }
  if (el.modelListSummary) {
    el.modelListSummary.textContent = query
      ? `${shownProviders}/${groups.size} Provider · ${shownModels}/${totalModels} 模型`
      : `${groups.size} Provider · ${totalModels} 模型`;
  }
  renderModelSettingsSummary();
}

function parseProviderModels(value) {
  const lines = String(value || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line) => {
    const divider = line.indexOf("|");
    const id = (divider === -1 ? line : line.slice(0, divider)).trim();
    const name = (divider === -1 ? "" : line.slice(divider + 1)).trim();
    return { id, ...(name ? { name } : {}) };
  });
}

function setProviderFormError(message = "") {
  if (!el.providerFormError) return;
  el.providerFormError.textContent = message;
  el.providerFormError.classList.toggle("hidden", !message);
}

function closeProviderDialog() {
  el.providerDialog?.classList.add("hidden");
  providerDialogExisting = null;
  providerDialogPreset = null;
  if (el.providerFilter) el.providerFilter.value = "";
  if (el.providerSimpleApiKey) el.providerSimpleApiKey.value = "";
  el.providerApiKeyEntry?.classList.add("hidden");
  el.providerSwitchDevice?.classList.add("hidden");
  el.providerSimpleStatus?.classList.remove("is-readonly");
  setProviderFormError();
}

function providerAuthTypeLabel(type) {
  return window.piI18n?.t(type === "oauth" ? "Sign in with an account" : "Use an API key") || (type === "oauth" ? "Sign in with an account" : "Use an API key");
}

const PROVIDER_CATEGORY_META = Object.freeze({
  free: { label: "免費／免帳戶", note: "本機服務直接使用，不需要帳號或 API key。" },
  paid: { label: "API key／付費服務", note: "貼上服務提供的 API key，費用與額度由服務商管理。" },
  account: { label: "帳戶登入", note: "使用官方帳號或訂閱登入，Pi 會自動保存並更新憑證。" },
});

function renderProviderPresets() {
  if (!el.providerPresetList) return;
  el.providerPresetList.innerHTML = "";
  if (providerCatalogLoading) {
    el.providerPresetList.innerHTML = '<p class="settings-note">讀取 Provider 清單中…</p>';
    return;
  }
  if (!providerCatalog.length) {
    el.providerPresetList.innerHTML = '<p class="settings-note error-text">目前無法讀取可用 Provider，請稍後再試。</p>';
    return;
  }
  if (providerCatalogNotice) {
    const notice = document.createElement("p");
    notice.className = "settings-note provider-compat-note";
    notice.textContent = providerCatalogNotice;
    el.providerPresetList.appendChild(notice);
  }
  const query = String(el.providerFilter?.value || "").trim().toLocaleLowerCase();
  const matches = (provider) => {
    if (!query) return true;
    const category = PROVIDER_CATEGORY_META[provider.category || "paid"]?.label || "";
    return [provider.id, provider.name, provider.description, category]
      .filter(Boolean).some((value) => String(value).toLocaleLowerCase().includes(query));
  };
  const order = ["free", "paid", "account"];
  let visibleCount = 0;
  for (const category of order) {
    const providers = providerCatalog
      .filter((provider) => (provider.category || "paid") === category && matches(provider))
      .sort((a, b) => {
        // Nous Research 是使用者特別需要的入口，放在帳戶分類最前面，
        // 但仍保留完整搜尋與分類結構。
        if (category === "account" && a.id === "nous") return -1;
        if (category === "account" && b.id === "nous") return 1;
        return String(a.name || a.id).localeCompare(String(b.name || b.id));
      });
    if (!providers.length) continue;
    visibleCount += providers.length;
    const meta = PROVIDER_CATEGORY_META[category] || PROVIDER_CATEGORY_META.paid;
    const section = document.createElement("section");
    section.className = `provider-preset-section provider-preset-section-${category}`;
    const searching = !!query;
    const collapsed = !searching && collapsedProviderCategories.has(category);
    const heading = document.createElement("button");
    heading.type = "button";
    heading.className = "provider-preset-heading" + (collapsed ? " collapsed" : "");
    heading.dataset.providerCategory = category;
    heading.setAttribute("aria-expanded", String(!collapsed));
    const title = document.createElement("strong");
    title.textContent = window.piI18n?.t(meta.label) || meta.label;
    const note = document.createElement("small");
    note.textContent = `${providers.length}${window.piI18n?.t("個服務") || " service(s)"} · ${window.piI18n?.t(meta.note) || meta.note}`;
    const chevron = document.createElement("span");
    chevron.className = "provider-preset-chevron";
    chevron.textContent = "⌄";
    heading.append(title, note, chevron);
    const list = document.createElement("div");
    list.className = "provider-preset-group" + (collapsed ? " collapsed" : "");
    for (const provider of providers) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "provider-preset" + (providerDialogPreset?.id === provider.id ? " selected" : "");
      button.dataset.providerId = provider.id;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", providerDialogPreset?.id === provider.id ? "true" : "false");
      const copy = document.createElement("span");
      copy.className = "provider-preset-copy";
      const name = document.createElement("strong");
      name.textContent = window.piI18n?.providerName(provider) || provider.name;
      const description = document.createElement("small");
      description.textContent = window.piI18n?.providerDescription(provider) || provider.description;
      copy.append(name, description);
      const status = document.createElement("span");
      status.className = "provider-preset-status";
      status.textContent = provider.configured ? (window.piI18n?.t("已設定") || "Configured") : "";
      const chevron = document.createElement("span");
      chevron.className = "row-chevron";
      chevron.textContent = "→";
      button.append(copy, status, chevron);
      list.appendChild(button);
    }
    section.append(heading, list);
    el.providerPresetList.appendChild(section);
  }
  if (!visibleCount) {
    const empty = document.createElement("p");
    empty.className = "settings-note";
    empty.textContent = `找不到「${String(el.providerFilter?.value || "").trim()}」；可以試試服務商名稱或 Provider ID。`;
    el.providerPresetList.appendChild(empty);
  }
}

function selectProviderPreset(provider) {
  providerDialogPreset = provider;
  collapsedProviderCategories.delete(provider.category || "paid");
  renderProviderPresets();
  if (el.providerSelectedName) el.providerSelectedName.textContent = window.piI18n?.providerName(provider) || provider.name;
  if (el.providerSelectedDescription) el.providerSelectedDescription.textContent = window.piI18n?.providerDescription(provider) || provider.description || "";
  const isFree = provider.kind === "free";
  const authTypes = new Set(provider.authTypes || []);
  el.providerAuthOptions?.classList.remove("hidden");
  el.providerApiKeyEntry?.classList.add("hidden");
  if (el.providerSimpleApiKey) el.providerSimpleApiKey.value = "";
  el.providerAuthBack?.classList.remove("hidden");
  if (providerCatalogReadOnly) {
    el.providerAuthAccount?.classList.add("hidden");
    el.providerAuthApi?.classList.add("hidden");
    el.providerFreeStart?.classList.add("hidden");
    el.providerAuthRemove?.classList.add("hidden");
    const canSwitchDevice = !!selfId && selectedId !== selfId && machines.length > 1;
    el.providerSwitchDevice?.classList.toggle("hidden", !canSwitchDevice);
    if (canSwitchDevice && el.providerSwitchDevice) {
      el.providerSwitchDevice.textContent = window.piI18n?.t("Switch device") || "Switch device";
    }
    if (el.providerSimpleStatus) {
      el.providerSimpleStatus.textContent = "Update Pi Harbor on this device to add or change provider credentials.";
      el.providerSimpleStatus.classList.add("is-readonly");
    }
    el.providerAuthOptions?.scrollIntoView({ block: "nearest", behavior: settings.reducedMotion ? "auto" : "smooth" });
    return;
  }
  el.providerAuthAccount?.classList.toggle("hidden", !authTypes.has("oauth"));
  el.providerAuthApi?.classList.toggle("hidden", !authTypes.has("api_key"));
  el.providerFreeStart?.classList.toggle("hidden", !isFree);
  el.providerAuthRemove?.classList.toggle("hidden", !provider.configured);
  el.providerSwitchDevice?.classList.add("hidden");
  el.providerSimpleStatus?.classList.remove("is-readonly");
  if (el.providerAuthRemove) el.providerAuthRemove.textContent = isFree ? "移除這個 Provider" : "移除這個登入設定";
  el.providerSimpleStatus.textContent = isFree
    ? (provider.configured ? `${provider.name} 已加入；重新掃描可以更新模型清單。` : "按一下直接掃描這台 Mac 的本機模型。")
    : (provider.configured ? `${provider.name} 已有登入設定；重新選擇登入方式即可更新。` : "選一種登入方式開始。");
  el.providerAuthOptions?.scrollIntoView({ block: "nearest", behavior: settings.reducedMotion ? "auto" : "smooth" });
}

async function loadProviderCatalog(force = false) {
  if (providerCatalogLoading && !force) return providerCatalogRequest;
  const machine = modelMachineKey();
  if (providerCatalog.length && !force && providerCatalogMachine === machine) {
    renderProviderPresets();
    return providerCatalog;
  }
  providerCatalogLoading = true;
  renderProviderPresets();
  const machineAtStart = machine;
  const request = api("/api/provider-catalog");
  providerCatalogRequest = request;
  try {
    const result = await request;
    if (machineAtStart !== modelMachineKey()) return providerCatalog;
    providerCatalog = Array.isArray(result?.providers) ? result.providers : [];
    providerCatalogReadOnly = false;
    providerCatalogNotice = "";
    providerCatalogMachine = machineAtStart;
    el.providerAdvancedToggle?.classList.toggle("hidden", !!providerDialogExisting);
    return providerCatalog;
  } catch (error) {
    // A remote device running an older Pi Harbor can still use /api/models, but
    // it does not know the provider catalog/configuration endpoints. The
    // gateway owns the same static catalog, so show it read-only instead of
    // exposing a raw 404 or an empty picker.
    if (error?.status === 404 && apiBase) {
      try {
        const fallbackResponse = await fetch("/api/provider-catalog", { credentials: "same-origin", cache: "no-store" });
        if (!fallbackResponse.ok) throw new Error(`gateway provider catalog ${fallbackResponse.status}`);
        const fallback = await fallbackResponse.json();
        if (machineAtStart !== modelMachineKey()) return providerCatalog;
        providerCatalog = Array.isArray(fallback?.providers)
          ? fallback.providers.map((provider) => ({ ...provider, configured: false, configuredType: null }))
          : [];
        providerCatalogReadOnly = true;
        providerCatalogNotice = "This device is running an older Pi Harbor. The catalog is view-only until it is updated.";
        providerCatalogMachine = machineAtStart;
        el.providerAdvancedToggle?.classList.add("hidden");
        setProviderFormError();
        return providerCatalog;
      } catch {}
    }
    providerCatalog = [];
    providerCatalogReadOnly = false;
    providerCatalogNotice = "";
    providerCatalogMachine = machineAtStart;
    setProviderFormError(error.message || "無法讀取 Provider 清單");
    return [];
  } finally {
    if (providerCatalogRequest === request) {
      providerCatalogRequest = null;
      providerCatalogLoading = false;
      renderProviderPresets();
    }
  }
}

function showProviderAdvancedFields() {
  el.providerSimpleFlow?.classList.add("hidden");
  el.providerAdvancedFields?.classList.remove("hidden");
  el.providerAdvancedToggle?.classList.add("hidden");
  el.providerSave?.classList.remove("hidden");
  setTimeout(() => el.providerId?.focus(), 0);
}

function openProviderDialog(provider = null) {
  providerDialogMode = provider ? "edit" : "add";
  providerDialogExisting = provider;
  providerDialogPreset = null;
  collapsedProviderCategories.clear();
  for (const category of ["free", "paid", "account"]) collapsedProviderCategories.add(category);
  if (el.providerFilter) el.providerFilter.value = "";
  if (el.providerDialogTitle) el.providerDialogTitle.textContent = provider ? `編輯 ${provider.id}` : "新增 Provider";
  if (el.providerId) {
    el.providerId.value = provider?.id || "";
    el.providerId.readOnly = !!provider;
  }
  if (el.providerApi) el.providerApi.value = provider?.api || "openai-completions";
  if (el.providerBaseUrl) el.providerBaseUrl.value = provider?.baseUrl || "";
  if (el.providerApiKey) {
    el.providerApiKey.value = "";
    el.providerApiKey.placeholder = provider?.hasApiKey ? "留空以保留目前 API key" : "可填 $ENV_VAR 或 !command";
  }
  if (el.providerModels) el.providerModels.value = providerModelLines(provider);
  if (el.providerDelete) el.providerDelete.classList.toggle("hidden", !provider);
  el.providerSimpleFlow?.classList.toggle("hidden", !!provider);
  el.providerAdvancedFields?.classList.toggle("hidden", !provider);
  el.providerAdvancedToggle?.classList.toggle("hidden", !!provider);
  el.providerSave?.classList.toggle("hidden", !provider);
  el.providerAuthOptions?.classList.add("hidden");
  el.providerApiKeyEntry?.classList.add("hidden");
  if (el.providerSimpleApiKey) el.providerSimpleApiKey.value = "";
  el.providerAuthBack?.classList.remove("hidden");
  el.providerFreeStart?.classList.add("hidden");
  el.providerAuthRemove?.classList.add("hidden");
  if (el.providerAuthRemove) el.providerAuthRemove.textContent = "移除這個登入設定";
  if (el.providerSimpleStatus) {
    el.providerSimpleStatus.textContent = "";
    el.providerSimpleStatus.classList.remove("is-readonly");
  }
  el.providerSwitchDevice?.classList.add("hidden");
  renderProviderPresets();
  setProviderFormError();
  el.providerDialog?.classList.remove("hidden");
  if (!provider) void loadProviderCatalog();
  else setTimeout(() => el.providerId?.focus(), 0);
}

function closeProviderAuthClient() {
  if (providerAuthRun) providerAuthRun.streamEnded = true;
  if (providerAuthRun?.reconnectTimer) clearTimeout(providerAuthRun.reconnectTimer);
  providerAuthRun = null;
  try { providerAuthStream?.close(); } catch {}
  providerAuthStream = null;
  providerAuthRequest = null;
  if (extensionUiRequest?.kind === "provider-auth") extensionUiRequest = null;
  providerAuthNotice = "";
  providerAuthUrl = "";
  el.extensionUiSheet?.classList.add("hidden");
  el.extensionUiInput.value = "";
  el.extensionUiInput.type = "text";
}

function showProviderAuthPrompt(request, run) {
  if (!request || !run) return;
  providerAuthNotice = providerAuthNotice || "";
  providerAuthRequest = request;
  extensionUiRequest = { kind: "provider-auth", runId: run.runId, id: request.id, method: request.type };
  el.extensionUiKind.textContent = "PROVIDER LOGIN";
  el.extensionUiTitle.textContent = `登入 ${run.providerName || "Provider"}`;
  el.extensionUiMessage.textContent = [providerAuthNotice, request.message].filter(Boolean).join("\n\n");
  el.extensionUiOptions.innerHTML = "";
  el.extensionUiInput.classList.add("hidden");
  el.extensionUiEditor.classList.add("hidden");
  el.extensionUiSubmit.classList.add("hidden");
  el.extensionUiInput.type = request.type === "secret" ? "password" : "text";

  // OAuth flows emit an authorization URL immediately before asking for a
  // manual code. Keep that URL visible in the prompt so remote/mobile users
  // can open the official login page without losing it between SSE events.
  if (providerAuthUrl) {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "action-row extension-ui-option";
    link.textContent = window.piI18n?.t("Open official sign-in page") || "Open official sign-in page";
    link.addEventListener("click", () => window.open(providerAuthUrl, "_blank", "noopener,noreferrer"));
    el.extensionUiOptions.appendChild(link);
  }

  if (request.type === "select") {
    for (const option of Array.isArray(request.options) ? request.options : []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "action-row extension-ui-option";
      button.textContent = option.description ? `${option.label} · ${option.description}` : option.label;
      button.addEventListener("click", () => finishExtensionUi({ value: option.id }));
      el.extensionUiOptions.appendChild(button);
    }
  } else {
    el.extensionUiInput.placeholder = request.placeholder || (request.type === "secret" ? "貼上 API key" : "輸入內容");
    el.extensionUiInput.value = "";
    el.extensionUiInput.classList.remove("hidden");
    el.extensionUiSubmit.textContent = "送出";
    el.extensionUiSubmit.classList.remove("hidden");
    el.extensionUiSubmit.onclick = () => finishExtensionUi({ value: el.extensionUiInput.value });
  }
  el.extensionUiSheet.classList.remove("hidden");
  if (request.type !== "select") el.extensionUiInput.focus();
}

function showProviderAuthNotify(event, run) {
  if (!event || !run) return;
  const message = event.instructions || event.message || "請依畫面完成登入";
  providerAuthNotice = message;
  providerAuthUrl = event.url || event.verificationUrl || "";
  el.extensionUiKind.textContent = "PROVIDER LOGIN";
  el.extensionUiTitle.textContent = `登入 ${run.providerName || "Provider"}`;
  el.extensionUiMessage.textContent = message;
  el.extensionUiOptions.innerHTML = "";
  el.extensionUiInput.classList.add("hidden");
  el.extensionUiEditor.classList.add("hidden");
  el.extensionUiSubmit.classList.add("hidden");
  const verificationUrl = providerAuthUrl;
  if (verificationUrl) {
    const link = document.createElement("button");
    link.type = "button";
    link.className = "action-row extension-ui-option";
    link.textContent = event.type === "device_code" ? "開啟官方驗證頁面" : "開啟官方登入頁面";
    link.addEventListener("click", () => window.open(verificationUrl, "_blank", "noopener,noreferrer"));
    el.extensionUiOptions.appendChild(link);
  }
  if (event.type === "device_code" && event.userCode) {
    const code = document.createElement("p");
    code.className = "settings-note provider-auth-code";
    code.textContent = `驗證碼：${event.userCode}`;
    el.extensionUiOptions.appendChild(code);
  }
  el.extensionUiSheet.classList.remove("hidden");
}

function handleProviderAuthEvent(event) {
  const run = providerAuthRun;
  if (!run || !event) return;
  if (event.type === "prompt") {
    showProviderAuthPrompt(event.request, run);
  } else if (event.type === "notify") {
    showProviderAuthNotify(event.event, run);
  } else if (event.type === "success") {
    const name = event.providerName || run.providerName || "Provider";
    closeProviderAuthClient();
    toast(`${name} 已設定`);
    void loadProviderCatalog(true);
    void loadModelVisibility(true, true);
  } else if (event.type === "error") {
    const message = event.message || "Provider 登入失敗";
    closeProviderAuthClient();
    toast(message, true);
  } else if (event.type === "cancelled") {
    closeProviderAuthClient();
    const message = event.reason === "timeout"
      ? "Provider 登入等待逾時，請重新開始並盡快貼上重新導向網址"
      : event.reason === "replaced"
        ? "這次 Provider 登入已被另一個登入嘗試取代，請只保留一個登入視窗"
        : "已取消 Provider 登入";
    toast(message, event.reason === "timeout" || event.reason === "replaced");
  }
}

function showProviderApiKeyEntry() {
  if (!providerDialogPreset || !el.providerApiKeyEntry) return;
  el.providerApiKeyEntry.classList.remove("hidden");
  el.providerAuthAccount?.classList.add("hidden");
  el.providerAuthApi?.classList.add("hidden");
  el.providerFreeStart?.classList.add("hidden");
  el.providerAuthRemove?.classList.add("hidden");
  el.providerAuthBack?.classList.add("hidden");
  if (el.providerSimpleStatus) el.providerSimpleStatus.textContent = `${providerDialogPreset.name} 的 API key 只會儲存在這台電腦。`;
  el.providerApiKeyEntry.scrollIntoView({ block: "nearest", behavior: settings.reducedMotion ? "auto" : "smooth" });
  setTimeout(() => el.providerSimpleApiKey?.focus(), 0);
}

function hideProviderApiKeyEntry() {
  el.providerApiKeyEntry?.classList.add("hidden");
  if (el.providerSimpleApiKey) el.providerSimpleApiKey.value = "";
  if (!providerDialogPreset) return;
  const authTypes = new Set(providerDialogPreset.authTypes || []);
  const isFree = providerDialogPreset.kind === "free";
  el.providerAuthAccount?.classList.toggle("hidden", !authTypes.has("oauth"));
  el.providerAuthApi?.classList.toggle("hidden", !authTypes.has("api_key"));
  el.providerFreeStart?.classList.toggle("hidden", !isFree);
  el.providerAuthRemove?.classList.toggle("hidden", !providerDialogPreset.configured);
  el.providerAuthBack?.classList.remove("hidden");
  if (el.providerSimpleStatus) el.providerSimpleStatus.textContent = isFree
    ? (providerDialogPreset.configured ? `${providerDialogPreset.name} 已加入；重新掃描可以更新模型清單。` : "按一下直接掃描這台 Mac 的本機模型。")
    : (providerDialogPreset.configured ? `${providerDialogPreset.name} 已有登入設定；重新選擇登入方式即可更新。` : "選一種登入方式開始。");
}

function openProviderAuthStream(after = -1) {
  const run = providerAuthRun;
  if (!run || run.streamEnded) return;
  const stream = new EventSource(apiBase + "/api/provider-auth/stream?runId=" + encodeURIComponent(run.runId) + "&after=" + encodeURIComponent(after));
  providerAuthStream = stream;
  stream.onopen = () => { run.reconnectAttempt = 0; run.streamReady = true; };
  stream.addEventListener("connected", () => {
    if (providerAuthRun === run) {
      run.streamReady = true;
      run.reconnectAttempt = 0;
    }
  });
  stream.onmessage = (event) => {
    if (providerAuthRun !== run) { try { stream.close(); } catch {} return; }
    const eventId = Number(event.lastEventId);
    if (Number.isFinite(eventId)) run.lastEventId = Math.max(run.lastEventId, eventId);
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    handleProviderAuthEvent(data);
  };
  stream.onerror = () => {
    if (providerAuthRun !== run || run.streamEnded) return;
    try { stream.close(); } catch {}
    if (providerAuthStream === stream) providerAuthStream = null;
    if (run.reconnectTimer) return;
    const delay = Math.min(15_000, 700 * (2 ** Math.min(run.reconnectAttempt++, 5)));
    run.reconnectTimer = setTimeout(() => {
      run.reconnectTimer = null;
      openProviderAuthStream(Math.max(-1, Number(run.lastEventId) || -1));
    }, delay);
  };
}

function watchProviderAuth(result, provider) {
  providerAuthNotice = "";
  providerAuthUrl = "";
  providerAuthRun = {
    runId: result.runId,
    providerName: provider.name,
    lastEventId: -1,
    reconnectAttempt: 0,
    reconnectTimer: null,
    streamReady: false,
    streamEnded: false,
  };
  openProviderAuthStream();
}

async function beginProviderAuth(authType) {
  const provider = providerDialogPreset;
  if (!provider) {
    setProviderFormError("請先選擇一個 Provider。");
    return;
  }
  try {
    const result = await post("/api/provider-auth/start", { providerId: provider.id, authType });
    closeProviderDialog();
    watchProviderAuth(result, provider);
  } catch (error) {
    setProviderFormError(error.message || `${providerAuthTypeLabel(authType)}失敗`);
  }
}

async function saveProviderApiKey() {
  const provider = providerDialogPreset;
  const apiKey = String(el.providerSimpleApiKey?.value || "").trim();
  if (!provider) { setProviderFormError("請先選擇一個 Provider。"); return; }
  if (!apiKey) {
    setProviderFormError("請貼上 API key。");
    el.providerSimpleApiKey?.focus();
    return;
  }
  if (el.providerApiKeySave) el.providerApiKeySave.disabled = true;
  setProviderFormError();
  if (el.providerSimpleStatus) el.providerSimpleStatus.textContent = "正在儲存並檢查 API key…";
  try {
    const result = await post("/api/provider-auth/start", { providerId: provider.id, authType: "api_key", apiKey });
    closeProviderDialog();
    watchProviderAuth(result, provider);
  } catch (error) {
    setProviderFormError(error.message || "API key 設定失敗");
    if (el.providerSimpleStatus) el.providerSimpleStatus.textContent = "API key 尚未儲存，請確認區域與 key 是否相符。";
  } finally {
    if (el.providerApiKeySave) el.providerApiKeySave.disabled = false;
  }
}

async function beginFreeProvider() {
  const provider = providerDialogPreset;
  if (!provider || provider.kind !== "free") return;
  if (el.providerFreeStart) el.providerFreeStart.disabled = true;
  try {
    await post("/api/provider-free/setup", { providerId: provider.id });
    closeProviderDialog();
    await loadProviderCatalog(true);
    await loadModelVisibility(true, true);
    toast(`${provider.name} 已加入，模型清單已更新`);
  } catch (error) {
    setProviderFormError(error.message || "免費 Provider 設定失敗");
  } finally {
    if (el.providerFreeStart) el.providerFreeStart.disabled = false;
  }
}

async function cancelProviderAuth() {
  const run = providerAuthRun;
  if (!run) return;
  closeProviderAuthClient();
  try { await post("/api/provider-auth/cancel", { runId: run.runId }); } catch {}
}

async function removeProviderAuth() {
  const provider = providerDialogPreset;
  if (!provider?.configured) return;
  const isFree = provider.kind === "free";
  const confirmText = isFree
    ? `確定移除「${provider.name}」？\n之後仍可從免費清單重新加入。`
    : `確定移除「${provider.name}」的登入設定？\n只會移除本機憑證，不會刪除 Provider。`;
  if (!window.confirm(confirmText)) return;
  if (el.providerAuthRemove) el.providerAuthRemove.disabled = true;
  try {
    await post("/api/provider-auth/delete", { providerId: provider.id });
    closeProviderDialog();
    await loadProviderCatalog(true);
    await loadModelVisibility(true, true);
    toast(isFree ? `${provider.name} 已移除` : `${provider.name} 登入設定已移除`);
  } catch (error) {
    setProviderFormError(error.message || "移除登入設定失敗");
  } finally {
    if (el.providerAuthRemove) el.providerAuthRemove.disabled = false;
  }
}

async function saveProvider() {
  setProviderFormError();
  const id = String(el.providerId?.value || "").trim();
  const apiType = String(el.providerApi?.value || "");
  const baseUrl = String(el.providerBaseUrl?.value || "").trim();
  const models = parseProviderModels(el.providerModels?.value);
  if (!id || !baseUrl || !models.length) {
    setProviderFormError("請填寫 Provider ID、Base URL，並至少加入一個模型。");
    return;
  }
  const body = { id, api: apiType, baseUrl, models };
  const apiKey = String(el.providerApiKey?.value || "");
  if (apiKey) body.apiKey = apiKey;
  el.providerSave.disabled = true;
  try {
    await post("/api/model-providers", body);
    closeProviderDialog();
    await loadModelVisibility(true);
    toast(providerDialogMode === "edit" ? "Provider 已更新" : "Provider 已新增");
  } catch (e) {
    setProviderFormError(e.message || "儲存失敗");
  } finally {
    if (el.providerSave) el.providerSave.disabled = false;
  }
}

async function deleteProvider(provider) {
  if (!provider?.id || !window.confirm(`確定從 models.json 移除「${provider.id}」？\n不會刪除 auth.json 的登入憑證。`)) return;
  try {
    await post("/api/model-providers", { action: "delete", id: provider.id });
    closeProviderDialog();
    await loadModelVisibility(true);
    toast("Provider 已刪除");
  } catch (e) {
    setProviderFormError(e.message || "刪除失敗");
  }
}

async function loadModelVisibility(force = false, skipSession = false) {
  if (!el.modelVisibilityList) return;
  if (modelCatalogLoading && !force) return;
  if (modelCatalogRequest) modelCatalogRequest.abort();
  const machine = modelMachineKey();
  if (!force && modelCatalogMachine === machine) {
    renderModelVisibility();
    return;
  }
  const generation = viewGeneration;
  const baseAtStart = apiBase;
  modelCatalogLoading = true;
  const request = new AbortController();
  modelCatalogRequest = request;
  modelProviderError = "";
  modelProviderNotice = "";
  if (el.modelVisibilityRefresh) el.modelVisibilityRefresh.disabled = true;
  renderModelSettingsSummary();
  el.modelVisibilityList.innerHTML = '<p class="settings-note model-visibility-empty">讀取模型清單中…</p>';
  try {
    const sid = !skipSession && rpc?.sid ? `?sid=${encodeURIComponent(rpc.sid)}` : "";
    const [modelsResult, providersResult] = await Promise.allSettled([
      api("/api/models" + sid, { signal: request.signal }),
      api("/api/model-providers", { signal: request.signal }),
    ]);
    if (request.signal.aborted || generation !== viewGeneration || baseAtStart !== apiBase) return;
    if (modelsResult.status === "rejected") throw modelsResult.reason;
    modelCatalog = Array.isArray(modelsResult.value?.models) ? modelsResult.value.models : [];
    if (providersResult.status === "fulfilled") {
      configuredProviders = Array.isArray(providersResult.value?.providers) ? providersResult.value.providers : [];
      modelProviderError = "";
      modelProviderNotice = "";
    } else {
      configuredProviders = [];
      const providerError = providersResult.reason;
      if (providerError?.status === 404 && apiBase) {
        modelProviderError = "";
        modelProviderNotice = "Provider management requires Pi Harbor 1.10.5 or later on this device.";
      } else {
        modelProviderError = providerError?.message || "unknown error";
        modelProviderNotice = "";
      }
    }
    modelCatalogMachine = machine;
    renderModelVisibility();
  } catch (e) {
    if (e.name === "AbortError") return;
    if (generation === viewGeneration && baseAtStart === apiBase) {
      el.modelVisibilityList.innerHTML = "";
      const error = document.createElement("p");
      error.className = "settings-note model-visibility-empty error-text";
      error.textContent = "讀取失敗：" + (e.message || "unknown error");
      el.modelVisibilityList.appendChild(error);
    }
  } finally {
    if (modelCatalogRequest === request) {
      modelCatalogLoading = false;
      modelCatalogRequest = null;
      if (el.modelVisibilityRefresh) el.modelVisibilityRefresh.disabled = false;
    }
  }
}

el.modelVisibilityRefresh?.addEventListener("click", () => loadModelVisibility(true));
el.modelFilter?.addEventListener("input", () => renderModelVisibility());
el.providerFilter?.addEventListener("input", () => renderProviderPresets());
el.providerAdd?.addEventListener("click", () => openProviderDialog());
el.providerCancel?.addEventListener("click", closeProviderDialog);
el.providerCancelBottom?.addEventListener("click", closeProviderDialog);
el.providerPresetList?.addEventListener("click", (event) => {
  const heading = event.target.closest("[data-provider-category]");
  if (heading) {
    const category = heading.dataset.providerCategory;
    if (collapsedProviderCategories.has(category)) collapsedProviderCategories.delete(category);
    else collapsedProviderCategories.add(category);
    renderProviderPresets();
    return;
  }
  const button = event.target.closest("[data-provider-id]");
  if (!button) return;
  const provider = providerCatalog.find((item) => item.id === button.dataset.providerId);
  if (provider) selectProviderPreset(provider);
});
el.providerAuthAccount?.addEventListener("click", () => void beginProviderAuth("oauth"));
el.providerAuthApi?.addEventListener("click", showProviderApiKeyEntry);
el.providerApiKeyBack?.addEventListener("click", hideProviderApiKeyEntry);
el.providerApiKeySave?.addEventListener("click", () => void saveProviderApiKey());
el.providerFreeStart?.addEventListener("click", () => void beginFreeProvider());
el.providerAuthRemove?.addEventListener("click", () => void removeProviderAuth());
el.providerSwitchDevice?.addEventListener("click", () => {
  if (!selfId || selectedId === selfId) return;
  closeProviderDialog();
  switchMachine(selfId, true);
  showSettings();
  showModelSettings();
});
el.providerAuthBack?.addEventListener("click", () => {
  hideProviderApiKeyEntry();
  providerDialogPreset = null;
  el.providerAuthOptions?.classList.add("hidden");
  if (el.providerSimpleStatus) {
    el.providerSimpleStatus.textContent = "";
    el.providerSimpleStatus.classList.remove("is-readonly");
  }
  el.providerSwitchDevice?.classList.add("hidden");
  renderProviderPresets();
});
el.providerAdvancedToggle?.addEventListener("click", showProviderAdvancedFields);
el.providerSave?.addEventListener("click", saveProvider);
el.providerDelete?.addEventListener("click", () => deleteProvider(providerDialogExisting));
el.modelVisibilityList?.addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-model-provider-toggle]");
  if (toggle) {
    const provider = toggle.dataset.modelProviderToggle;
    if (expandedModelProviders.has(provider)) expandedModelProviders.delete(provider);
    else expandedModelProviders.add(provider);
    renderModelVisibility();
    return;
  }
  const button = event.target.closest("[data-provider-action]");
  if (!button) return;
  const provider = configuredProviders.find((item) => item.id === button.dataset.providerId);
  if (!provider) return;
  if (button.dataset.providerAction === "edit") openProviderDialog(provider);
  if (button.dataset.providerAction === "delete") deleteProvider(provider);
});
el.setDesignTheme?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-theme]");
  if (!button || !DESIGN_THEME_IDS.has(button.dataset.theme)) return;
  settings = saveSettings({ designTheme: button.dataset.theme });
  applyAppearance();
  renderThemeChoices();
});
el.setLocale?.addEventListener("change", () => {
  settings = saveSettings({ locale: window.piI18n?.normalizeLocale(el.setLocale.value) || "en" });
  window.piI18n?.setLocale(settings.locale);
  renderSettings();
  renderSessionList(el.search?.value || "");
  renderTemporarySessionFilter(temporarySessionCount);
  if (!el.onboarding?.classList.contains("hidden")) renderOnboarding();
  if (!el.viewModelSettings.classList.contains("hidden")) {
    renderModelVisibility();
    renderProviderPresets();
  }
});
el.setSidebarWidth?.addEventListener("input", () => {
  const width = Math.min(440, Math.max(280, Number(el.setSidebarWidth.value) || 336));
  settings = saveSettings({ sidebarWidth: width });
  if (el.setSidebarWidthValue) el.setSidebarWidthValue.textContent = `${width}px`;
  applyAppearance();
});
el.setFontScale?.addEventListener("input", () => {
  const fontScale = Math.min(125, Math.max(90, Number(el.setFontScale.value) || 100));
  settings = saveSettings({ fontScale });
  if (el.setFontScaleValue) el.setFontScaleValue.textContent = `${fontScale}%`;
  applyAppearance();
});
el.setTheme.addEventListener("change", () => { settings = saveSettings({ theme: el.setTheme.value }); applyAppearance(); });
el.setCompact.addEventListener("change", () => { settings = saveSettings({ compact: el.setCompact.checked }); applyAppearance(); });
el.setGroup.addEventListener("change", () => { settings = saveSettings({ groupByProject: el.setGroup.checked }); renderSessionList(el.search.value); });
el.setReducedMotion.addEventListener("change", () => { settings = saveSettings({ reducedMotion: el.setReducedMotion.checked }); applyAppearance(); });
el.setThinking.addEventListener("change", () => { settings = saveSettings({ thinking: el.setThinking.value }); });
el.setAutoUpdate?.addEventListener("change", () => { void saveAutomaticUpdates(el.setAutoUpdate.checked); });
el.updateCheck?.addEventListener("click", () => { void runUpdateCheck(); });
el.btnResetSettings?.addEventListener("click", () => {
  if (!confirm("要恢復介面預設設定嗎？登入狀態與 session 不會受到影響。")) return;
  try {
    localStorage.removeItem(SETTINGS_KEY);
    for (const key of LEGACY_SETTINGS_KEYS || [LEGACY_SETTINGS_KEY]) localStorage.removeItem(key);
  } catch {}
  settings = { ...DEFAULT_SETTINGS };
  applyAppearance();
  renderSettings();
  renderSessionList(el.search.value);
  toast("介面設定已恢復預設");
});

function renderMachineList() {
  if (!el.machineList) return;
  el.machineList.innerHTML = "";
  for (const m of machines) {
    const row = document.createElement("div");
    row.className = "machine-row clickable" + (m.id === selectedId ? " current" : "");
    const status = machineStatuses.get(m.id) || "unknown";
    row.classList.add(`machine-status-${status}`);
    row.innerHTML = `
      <span class="m-dot" title=""></span>
      <span class="m-info"><strong></strong><small></small></span>
      <span class="machine-row-actions"></span>
      <span class="row-chevron">›</span>`;
    const displayName = machineDisplayName(m);
    row.querySelector("strong").textContent = displayName;
    const statusLabel = status === "online" ? "在線" : status === "offline" ? "離線" : status === "checking" ? "檢查中" : "尚未檢查";
    row.querySelector(".m-dot").title = statusLabel;
    // Hostnames are implementation details; the row only needs the state.
    row.querySelector("small").textContent = m.id === selectedId
      ? `使用中 · ${statusLabel}` : statusLabel;
    const actions = row.querySelector(".machine-row-actions");
    const edit = document.createElement("button");
    edit.type = "button"; edit.className = "icon-button-small machine-row-action";
    edit.title = `編輯 ${displayName}`; edit.setAttribute("aria-label", `編輯 ${displayName}`);
    edit.innerHTML = '<svg class="icon"><use href="#i-pencil"></use></svg>';
    edit.addEventListener("click", (event) => { event.stopPropagation(); void openMachineDialog(m); });
    actions.appendChild(edit);
    if (m.managed) {
      const remove = document.createElement("button");
      remove.type = "button"; remove.className = "icon-button-small machine-row-action danger-text";
      remove.title = `刪除 ${displayName}`; remove.setAttribute("aria-label", `刪除 ${displayName}`);
      remove.innerHTML = '<svg class="icon"><use href="#i-x"></use></svg>';
      remove.addEventListener("click", (event) => { event.stopPropagation(); void openMachineDialog(m); });
      actions.appendChild(remove);
    }
    row.addEventListener("click", () => {
      if (m.id === selectedId) { toast("已在這台設備上"); return; }
      switchMachine(m.id);
      renderMachineList();
      if (!el.viewSettings.classList.contains("hidden")) renderSettings();
    });
    el.machineList.appendChild(row);
  }
}

let machineStatusRefreshAt = 0;
let machineStatusRequest = null;
async function fetchMachineStatusEndpoint(machine, endpoint) {
  const base = machine.local ? "" : `/r/${encodeURIComponent(machine.id)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${base}${endpoint}`, { credentials: "same-origin", signal: controller.signal, cache: "no-store" });
    const result = { ok: response.ok, status: response.status };
    // Release the connection before a compatibility probe makes its fallback
    // request, especially on Safari where the body stream is not eagerly read.
    try { await response.arrayBuffer(); } catch {}
    return result;
  } catch { return null; }
  finally { clearTimeout(timeout); }
}
async function checkMachineStatus(machine) {
  const health = await fetchMachineStatusEndpoint(machine, "/api/health");
  if (health?.ok) return "online";
  // Older Pi Harbor instances do not expose /api/health yet, but /api/machine is
  // available on those builds. Treat that compatibility response as online
  // instead of showing a healthy, actively used device as offline.
  if (!health || ![404, 405].includes(health.status)) return "offline";
  const machineInfo = await fetchMachineStatusEndpoint(machine, "/api/machine");
  return machineInfo?.ok ? "online" : "offline";
}

async function refreshMachineStatuses(force = false) {
  const now = Date.now();
  if (!force && (machineStatusRequest || now - machineStatusRefreshAt < 10_000)) return machineStatusRequest;
  machineStatusRefreshAt = now;
  const list = [...machines];
  for (const machine of list) machineStatuses.set(machine.id, "checking");
  renderMachineList();
  const request = Promise.all(list.map(async (machine) => [machine.id, await checkMachineStatus(machine)]));
  machineStatusRequest = request;
  try {
    const results = await request;
    for (const [id, status] of results) machineStatuses.set(id, status);
    renderMachineList();
  } finally {
    if (machineStatusRequest === request) machineStatusRequest = null;
  }
  return request;
}

function setMachineFormError(message = "") {
  if (!el.machineFormError) return;
  el.machineFormError.textContent = message;
  el.machineFormError.classList.toggle("hidden", !message);
}

async function openMachineDialog(machine = null, mode = machine ? "edit" : "add") {
  machineDialogExisting = machine;
  machineDialogMode = mode;
  machineDialogDeviceSettings = null;
  machineDialogRestartRequired = false;
  const isLocal = !!machine?.local;
  const pairing = mode === "pair";
  if (el.machineDialogTitle) el.machineDialogTitle.textContent = pairing ? "使用配對碼加入" : machine ? `編輯 ${machineDisplayName(machine)}` : "新增設備";
  if (el.machineName) el.machineName.value = machine ? machineDisplayName(machine) : "";
  if (el.machineUrl) el.machineUrl.value = machine?.url || "";
  if (el.machinePort) el.machinePort.value = "";
  if (el.machineHost) {
    el.machineHost.value = machine?.host || "";
    el.machineHost.readOnly = isLocal;
  }
  el.machinePortLabel?.classList.toggle("hidden", !isLocal || pairing);
  el.machinePort?.classList.toggle("hidden", !isLocal || pairing);
  el.machineDelete?.classList.toggle("hidden", pairing || !machine?.managed);
  el.machineTest?.classList.toggle("hidden", pairing || !machine);
  el.machineStandardFields?.classList.toggle("hidden", pairing);
  el.machinePairArea?.classList.toggle("hidden", !pairing);
  el.machinePairOfferArea?.classList.toggle("hidden", !isLocal || pairing);
  el.machineSave?.classList.toggle("hidden", pairing);
  el.machinePairCode.value = "";
  el.machinePairOffer.value = "";
  el.machineRestart?.classList.add("hidden");
  if (el.machineStatusNote) el.machineStatusNote.textContent = machine
    ? `目前狀態：${machineStatuses.get(machine.id) === "online" ? "在線" : machineStatuses.get(machine.id) === "offline" ? "離線" : "尚未檢查"}`
    : "儲存後會自動加入設備清單。";
  setMachineFormError();
  el.machineDialog?.classList.remove("hidden");
  if (isLocal && !pairing) {
    try {
      const response = await fetch("/api/device-settings", { credentials: "same-origin", cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || response.statusText);
      if (machineDialogExisting !== machine) return;
      machineDialogDeviceSettings = result.device || null;
      if (el.machineName) el.machineName.value = result.device?.name ? machineDisplayName(result.device) : machineDisplayName(machine);
      if (el.machineUrl) el.machineUrl.value = result.device?.publicUrl || machine?.url || "";
      if (el.machinePort) el.machinePort.value = result.device?.port || "";
      if (el.machineHost) el.machineHost.value = result.device?.host || machine?.host || "";
    } catch (error) {
      setMachineFormError(error.message || "讀取本機設備設定失敗");
    }
  }
  setTimeout(() => (pairing ? el.machinePairCode : isLocal ? el.machineName : machine ? el.machineUrl : el.machineName)?.focus(), 0);
}

function closeMachineDialog() {
  el.machineDialog?.classList.add("hidden");
  machineDialogExisting = null;
  machineDialogDeviceSettings = null;
  machineDialogRestartRequired = false;
  machineDialogMode = "edit";
  el.machinePortLabel?.classList.add("hidden");
  el.machinePort?.classList.add("hidden");
  el.machineRestart?.classList.add("hidden");
  el.machinePairArea?.classList.add("hidden");
  el.machinePairOfferArea?.classList.add("hidden");
  el.machineStandardFields?.classList.remove("hidden");
  el.machineSave?.classList.remove("hidden");
  setMachineFormError();
}

async function machineAdminRequest(body) {
  const response = await fetch("/api/machines", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (response.status === 401) { showLogin(); throw new Error("登入已過期"); }
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok) throw new Error(result.error || response.statusText || "設備設定失敗");
  return result;
}

async function generateMachinePairingOffer() {
  el.machinePairGenerate.disabled = true;
  setMachineFormError();
  try {
    const result = await post("/api/device-pairing/start", {});
    el.machinePairOffer.value = result.offer || "";
    el.machinePairOfferArea.classList.remove("hidden");
    if (el.machineStatusNote) el.machineStatusNote.textContent = "配對碼 5 分鐘內有效，複製到另一台 Pi Harbor 使用。";
    try { await navigator.clipboard?.writeText(result.offer || ""); toast("配對碼已複製"); }
    catch { toast("配對碼已產生，請手動複製"); }
  } catch (error) {
    setMachineFormError(error.message || "無法產生配對碼");
  } finally {
    el.machinePairGenerate.disabled = false;
  }
}

async function joinMachinePairing() {
  const offer = String(el.machinePairCode?.value || "").trim();
  if (!offer) { setMachineFormError("請貼上另一台設備產生的配對碼。"); return; }
  el.machinePairJoin.disabled = true;
  setMachineFormError();
  if (el.machineStatusNote) el.machineStatusNote.textContent = "正在驗證配對碼並測試遠端連線…";
  try {
    await post("/api/machines/pair", { offer });
    closeMachineDialog();
    await reloadMachineCatalog();
    toast("設備配對成功");
  } catch (error) {
    setMachineFormError(error.message || "設備配對失敗");
    if (el.machineStatusNote) el.machineStatusNote.textContent = "配對失敗；請確認配對碼尚未過期，以及兩台設備使用相同 token。";
  } finally {
    el.machinePairJoin.disabled = false;
  }
}

async function reloadMachineCatalog() {
  const response = await fetch("/api/machines", { credentials: "same-origin" });
  if (response.status === 401) { showLogin(); throw new Error("登入已過期"); }
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error || response.statusText || "無法讀取設備清單");
  machines = Array.isArray(data?.machines) ? data.machines : [];
  selfId = data?.current || null;
  if (!machines.some((machine) => machine.id === selectedId)) {
    selectedId = selfId || machines[0]?.id || null;
    saveSelected(selectedId);
    applyApiBase();
  }
  renderMachineSwitch();
  renderMachineList();
  if (!el.viewSettings.classList.contains("hidden")) renderSettings();
}

async function testMachineDialogConnection() {
  const machine = machineDialogExisting;
  if (!machine) return;
  el.machineTest.disabled = true;
  if (el.machineStatusNote) el.machineStatusNote.textContent = "正在測試連線…";
  const status = await checkMachineStatus(machine);
  machineStatuses.set(machine.id, status);
  renderMachineList();
  if (el.machineStatusNote) el.machineStatusNote.textContent = status === "online"
    ? "連線成功，Pi Harbor 正常回應。" : "連線失敗；請確認 Pi Harbor、port 與 Tailscale／HTTPS 網址。";
  el.machineTest.disabled = false;
}

async function saveMachineDialog() {
  const name = String(el.machineName?.value || "").trim();
  const url = String(el.machineUrl?.value || "").trim();
  const host = String(el.machineHost?.value || "").trim() || name;
  const existing = machineDialogExisting;
  const isLocal = !!existing?.local;
  const port = Number(el.machinePort?.value || 0);
  if (!name || (!isLocal && !url)) { setMachineFormError(isLocal ? "請填寫設備名稱。" : "請填寫設備名稱與 Pi Harbor 網址。"); return; }
  if (isLocal && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
    setMachineFormError("Pi Harbor port 必須是 1024–65535 的整數。"); return;
  }
  el.machineSave.disabled = true;
  setMachineFormError();
  const isEdit = !!existing;
  try {
    if (isLocal) {
      const result = await post("/api/device-settings", { name, port, publicUrl: url });
      machineDialogRestartRequired = !!result.restartRequired;
      currentHost = name;
      await reloadMachineCatalog();
      if (machineDialogRestartRequired) {
        el.machineRestart?.classList.remove("hidden");
        if (el.machineStatusNote) el.machineStatusNote.textContent = "設定已保存；新的 port 需要重新啟動 Pi Harbor 後才會生效。";
        toast("設備名稱已更新；port 等待重啟後生效");
      } else {
        closeMachineDialog();
        toast("本機設備設定已更新");
      }
    } else {
      const body = { action: existing ? "update" : "add", name, url, host };
      if (existing) { body.oldId = existing.id; body.id = existing.id; }
      await machineAdminRequest(body);
      closeMachineDialog();
      await reloadMachineCatalog();
      toast(isEdit ? "設備已更新" : "設備已加入");
    }
  } catch (error) {
    setMachineFormError(error.message || "設備設定失敗");
  } finally {
    el.machineSave.disabled = false;
  }
}

async function restartMachineWeb() {
  if (!machineDialogExisting?.local || !confirm("重新啟動 Pi Harbor 會中斷目前的瀏覽連線；正在執行的 Pi 工作會先嘗試安全收尾。要繼續嗎？")) return;
  el.machineRestart.disabled = true;
  if (el.machineStatusNote) el.machineStatusNote.textContent = "正在要求 Pi Harbor 重新啟動…";
  try {
    await post("/api/device-restart", {});
    toast("Pi Harbor 正在重新啟動");
    setTimeout(() => location.reload(), 1200);
  } catch (error) {
    el.machineRestart.disabled = false;
    setMachineFormError(error.message || "無法重新啟動 Pi Harbor");
  }
}

async function deleteMachineDialog() {
  if (!machineDialogExisting || !confirm(`確定要刪除「${machineDialogExisting.name}」嗎？`)) return;
  el.machineDelete.disabled = true;
  setMachineFormError();
  try {
    await machineAdminRequest({ action: "delete", id: machineDialogExisting.id });
    closeMachineDialog();
    await reloadMachineCatalog();
    toast("設備已刪除");
  } catch (error) {
    setMachineFormError(error.message || "設備刪除失敗");
  } finally {
    el.machineDelete.disabled = false;
  }
}

el.machineAdd?.addEventListener("click", () => void openMachineDialog());
el.machinePair?.addEventListener("click", () => void openMachineDialog(null, "pair"));
el.machineCancel?.addEventListener("click", closeMachineDialog);
el.machineCancelBottom?.addEventListener("click", closeMachineDialog);
el.machineSave?.addEventListener("click", () => void saveMachineDialog());
el.machineDelete?.addEventListener("click", () => void deleteMachineDialog());
el.machineTest?.addEventListener("click", () => void testMachineDialogConnection());
el.machineRestart?.addEventListener("click", () => void restartMachineWeb());
el.machinePairGenerate?.addEventListener("click", () => void generateMachinePairingOffer());
el.machinePairJoin?.addEventListener("click", () => void joinMachinePairing());

// ===========================================================================
// 新對話
// ===========================================================================

let projectFolder = { path: null, parent: null };
let projectFolderRequest = null;
let projectFolderSequence = 0;

function renderProjectFolderList(entries) {
  el.newFolderList.innerHTML = "";
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "project-folder-empty";
    empty.textContent = "這裡沒有可進入的子資料夾";
    el.newFolderList.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "project-folder-row";
    row.innerHTML = `<svg class="icon"><use href="#i-folder-filled"></use></svg><span class="project-folder-copy"><strong></strong><small></small></span><svg class="icon trailing"><use href="#i-chevron-right"></use></svg>`;
    row.querySelector("strong").textContent = entry.name;
    row.querySelector("small").textContent = entry.path;
    row.addEventListener("click", () => loadProjectFolder(entry.path));
    el.newFolderList.appendChild(row);
  }
}

async function loadProjectFolder(path = null) {
  const sequence = ++projectFolderSequence;
  if (projectFolderRequest) projectFolderRequest.abort();
  const request = new AbortController();
  projectFolderRequest = request;
  el.newFolderList.innerHTML = '<p class="project-folder-empty">讀取資料夾中…</p>';
  el.newFolderUp.disabled = true;
  try {
    const query = path ? "?path=" + encodeURIComponent(path) : "";
    const data = await api("/api/browse" + query, { signal: request.signal });
    if (sequence !== projectFolderSequence) return;
    projectFolder = { path: data.path || null, parent: data.parent || null };
    el.newCwd.value = data.path || "";
    el.newFolderPath.textContent = data.path || "—";
    el.newFolderUp.disabled = !data.parent || data.parent === data.path;
    renderProjectFolderList(data.entries || []);
  } catch (e) {
    if (e.name === "AbortError" || sequence !== projectFolderSequence) return;
    projectFolder = { path: null, parent: null };
    el.newCwd.value = "";
    el.newFolderPath.textContent = "讀取失敗";
    el.newFolderList.innerHTML = "";
    const error = document.createElement("p");
    error.className = "project-folder-empty error-text";
    error.textContent = "無法讀取資料夾：" + e.message;
    el.newFolderList.appendChild(error);
  } finally {
    if (projectFolderRequest === request) projectFolderRequest = null;
  }
}

function openNewDialog(initialCwd = null) {
  el.newCwd.value = "";
  el.newName.value = "";
  el.newDialog.classList.remove("hidden");
  loadProjectFolder(initialCwd || window._piHome || null);
}
el.btnNew.addEventListener("click", openNewDialog);
el.btnNewProject?.addEventListener("click", openNewDialog);
el.fabNew.addEventListener("click", openNewDialog);
el.newCancel.addEventListener("click", () => el.newDialog.classList.add("hidden"));
el.newFolderUp.addEventListener("click", () => {
  if (projectFolder.parent) loadProjectFolder(projectFolder.parent);
});
el.newFolderHome.addEventListener("click", () => loadProjectFolder(window._piHome || null));
el.newStart.addEventListener("click", async () => {
  const cwd = el.newCwd.value.trim();
  if (!cwd) { toast("請先選擇一個資料夾", true); return; }
  el.newDialog.classList.add("hidden");
  if (settings.removedProjects?.includes(cwd)) {
    settings = saveSettings({ removedProjects: settings.removedProjects.filter((value) => value !== cwd) });
  }
  await startNew(cwd, el.newName.value.trim() || null);
});

// ---- iOS 鍵盤適配：visualViewport 高度變化時收緊 composer ----
(() => {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    const overlap = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty("--kb", overlap + "px");
    if (!el.viewChat.classList.contains("hidden")) scrollBottom();
  };
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
})();

// ===========================================================================
// 啟動
// ===========================================================================

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "PI_HARBOR_UPDATED" || !navigator.serviceWorker.controller) return;
    if (rpc?.streaming) {
      toast("新版已準備好；目前工作完成後可重新整理。", false);
      return;
    }
    toast("Pi Harbor 已更新，正在重新載入…", false);
    setTimeout(() => location.reload(), 900);
  });
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
boot();
