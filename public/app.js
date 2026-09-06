/* stepsemble v3.0.6 — project changes, resilient drafts, and mobile polish */
"use strict";

const CLIENT_APP_VERSION = "3.0.6";

// The browser remains buildless, but feature-independent foundations live in
// small files loaded before this controller. This keeps deployment as simple
// as the original PWA while preventing storage, device, and display rules from
// being duplicated across future feature modules.
const foundation = window.stepsembleFoundation;
const sessionUtils = window.stepsembleSessionUtils;
const piSession = window.StepsemblePiSession;
const contextUtils = window.stepsembleContextUtils;
if (!foundation || !sessionUtils || !contextUtils || !piSession) throw new Error("Stepsemble foundation modules are missing");
const {
  SELECTED_KEY, SETTINGS_KEY, LEGACY_SETTINGS_KEY, LEGACY_SETTINGS_KEYS, SETTINGS_VERSION,
  DESIGN_THEMES, DESIGN_THEME_IDS, DEFAULT_SETTINGS,
  loadSelected, saveSelected, loadSettings, saveSettings,
  currentMachine: currentMachineFromList,
  machineDisplayName, machineDisplayHost, machineName: machineNameFromList,
  resolveMachineCatalogState,
} = foundation;
const {
  stripMd, fmtTime, fmtTokens, projectFolderName,
  draftScopeKey, normalizeDraftEntries, updateDraftEntries, draftTextForKey,
  activityReceiptStats, computeActivityReceipt,
  stripAnsi, parseTaskProgressLines, extractTaskPlan,
} = sessionUtils;
function sessionDisplayTitle(session) {
  return stripMd(piSession.title(session)).replace(/[\r\n]+/g, " ") || "(Untitled)";
}
const {
  finiteNonNegative, positiveFinite, normalizeWireUsage, normalizeSessionStats, mergeContextCapacity,
  computeCacheHitRate, formatTokenCount, formatPercent, usageTotalTokens, usageCostTotal,
  isContextRequestCurrent,
} = contextUtils;

function migratedStorageValue(storage, key, legacyKeys = []) {
  try {
    const current = storage.getItem(key);
    if (current !== null) return current;
    for (const legacyKey of legacyKeys) {
      const legacy = storage.getItem(legacyKey);
      if (legacy === null) continue;
      storage.setItem(key, legacy);
      return legacy;
    }
  } catch {}
  return null;
}

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
  loginOnboarding: $("login-onboarding"), loginOnboardingKey: $("login-onboarding-key"),
  loginOnboardingReveal: $("onboarding-reveal"), loginOnboardingCopy: $("onboarding-copy"),
  loginOnboardingSaved: $("onboarding-saved"), loginOnboardingUnderstood: $("onboarding-understood"),
  loginOnboardingContinue: $("onboarding-continue"), loginOnboardingSkip: $("login-onboarding-skip"),
  loginOnboardedHint: $("login-onboarded-hint"),
  app: $("app"),
  viewList: $("view-list"), viewChat: $("view-chat"), viewSettings: $("view-settings"), viewModelSettings: $("view-model-settings"),
  search: $("search"), btnRefresh: $("btn-refresh"),
  sessionList: $("session-list"), listEmpty: $("list-empty"),
  temporarySessionFilter: $("temporary-session-filter"), temporarySessionFilterLabel: $("temporary-session-filter-label"), temporarySessionFilterNote: $("temporary-session-filter-note"), stuckSessions: $("stuck-sessions"), temporarySessionFilterNote: $("temporary-session-filter-note"),
  temporarySessionCount: $("temporary-session-count"), showTemporarySessions: $("show-temporary-sessions"),
  btnNew: $("btn-new"), btnNewProject: $("btn-new-project"), pullIndicator: $("pull-indicator"),
  agentHubCard: $("agent-hub-card"), agentHubTitle: $("agent-hub-title"), agentHubSummary: $("agent-hub-summary"), agentHubRefresh: $("agent-hub-refresh"), agentHubOpenCenter: $("agent-hub-open-center"), agentHubConnectors: $("agent-hub-connectors"), agentTaskList: $("agent-task-list"),
  agentTaskCenter: $("agent-task-center"), agentTaskCenterClose: $("agent-task-center-close"), agentTaskCenterTitle: $("agent-task-center-title"), agentTaskCenterSummary: $("agent-task-center-summary"), agentTaskCenterSearch: $("agent-task-center-search"), agentTaskCenterFilter: $("agent-task-center-filter"), agentTaskCenterList: $("agent-task-center-list"), agentTaskCenterEmpty: $("agent-task-center-empty"),
  machineSwitch: $("machine-switch"), machineSwitchStatus: $("machine-switch-status"),
  machineCatalogStatus: $("machine-catalog-status"), machineCatalogStatusCopy: $("machine-catalog-status-copy"), machineCatalogRetry: $("machine-catalog-retry"),
  btnBack: $("btn-back"), chatTitle: $("chat-title"), chatSub: $("chat-sub"),
  chatHeadInfo: $("chat-head-info"), thinkingStatus: $("thinking-status"), btnChatMenu: $("btn-chat-menu"),
  runTimer: $("run-timer"),
  btnChanges: $("btn-changes"), changesBadge: $("changes-badge"), changesLayer: $("changes-layer"),
  changesTitle: $("changes-title"), changesRepository: $("changes-repository"), changesRefresh: $("changes-refresh"), changesClose: $("changes-close"),
  changesSummary: $("changes-summary"), changesFilesPane: $("changes-files-pane"), changesState: $("changes-state"), changesList: $("changes-list"),
  changesDiffPane: $("changes-diff-pane"), changesDetailBack: $("changes-detail-back"), changesDiffKind: $("changes-diff-kind"),
  changesDiffTitle: $("changes-diff-title"), changesDiffEmpty: $("changes-diff-empty"), changesDiff: $("changes-diff"),
  messages: $("messages"), scrollBottomBtn: $("scroll-bottom-btn"), queueNote: $("queue-note"),
  taskProgress: $("task-progress"), taskProgressPanel: $("task-progress-panel"), taskProgressHeading: $("task-progress-heading"),
  taskProgressState: $("task-progress-state"), taskProgressList: $("task-progress-list"), taskProgressDetail: $("task-progress-detail"),
  taskProgressNotes: $("task-progress-notes"), taskProgressToggle: $("task-progress-toggle"), taskProgressIndicator: $("task-progress-indicator"),
  taskProgressCount: $("task-progress-count"),
  contextDashboard: $("context-dashboard"), contextProgress: $("context-progress"), contextProgressFill: $("context-progress-fill"),
  contextInfo: $("context-info"), contextPopover: $("context-popover"),
  tokenAdd: $("token-add"), tokenCreateRow: $("token-create-row"), tokenLabel: $("token-label"),
  tokenCreate: $("token-create"), tokenCreateCancel: $("token-create-cancel"), tokenList: $("token-list"),
  tokenFormError: $("token-form-error"), tokenNewRow: $("token-new-row"), tokenNewValueText: $("token-new-value-text"),
  tokenNewCopy: $("token-new-copy"), tokenNewDone: $("token-new-done"),
  contextUsed: $("context-used"), contextCapacity: $("context-capacity"), contextPercent: $("context-percent"),
  contextInput: $("context-input"), contextOutput: $("context-output"), contextCacheHit: $("context-cache-hit"),
  contextCacheHitPercent: $("context-cache-hit-percent"), contextCacheWrite: $("context-cache-write"),
  contextDashboardStatus: $("context-dashboard-status"), contextDashboardSummary: $("context-dashboard-summary"),
  chatEmpty: $("chat-empty"), chatEmptyNewProject: $("chat-empty-new-project"), slashMenu: $("slash-menu"),
  input: $("input"), btnSend: $("btn-send"), btnAbort: $("btn-abort"), btnModel: $("btn-model"),
  sessionCount: $("session-count"), btnLayout: $("btn-layout"),
  composerModelNameText: $("composer-model-name"), composerModelLevelText: $("composer-model-level"),
  btnOpenSettings: $("btn-open-settings"), btnSettingsBack: $("btn-settings-back"), btnModelSettingsBack: $("btn-model-settings-back"), modelSettingsOpen: $("model-settings-open"), modelSettingsSummary: $("model-settings-summary"),
  machineList: $("machine-list"), machineAdd: $("machine-add"), machinePair: $("machine-pair"), machineDialog: $("machine-dialog"), machineDialogTitle: $("machine-dialog-title"), machineStandardFields: $("machine-standard-fields"), machineName: $("machine-name"), machineUrl: $("machine-url"), machinePort: $("machine-port"), machinePortLabel: $("machine-port-label"), machineHost: $("machine-host"), machineStatusNote: $("machine-status-note"), machineFormError: $("machine-form-error"), machinePairArea: $("machine-pair-area"), machinePairCode: $("machine-pair-code"), machinePairJoin: $("machine-pair-join"), machinePairPreview: $("machine-pair-preview"), machinePairPreviewName: $("machine-pair-preview-name"), machinePairPreviewUrl: $("machine-pair-preview-url"), machinePairPreviewExpires: $("machine-pair-preview-expires"), machinePairPreviewVersion: $("machine-pair-preview-version"), machinePairOfferArea: $("machine-pair-offer-area"), machinePairOffer: $("machine-pair-offer"), machinePairGenerate: $("machine-pair-generate"), machineRestart: $("machine-restart"), machineSave: $("machine-save"), machineDelete: $("machine-delete"), machineTest: $("machine-test"), machineCancel: $("machine-cancel"), machineCancelBottom: $("machine-cancel-bottom"),
  authorizedDevicesStatus: $("authorized-devices-status"), authorizedDeviceList: $("authorized-device-list"),
  setMachineName: $("set-machine-name"), setMachineHost: $("set-machine-host"), setPiVersion: $("set-pi-version"), setAppVersion: $("set-app-version"),
  btnLogout: $("btn-logout"), btnResetSettings: $("btn-reset-settings"), btnOpenOnboarding: $("btn-open-onboarding"), setupGuideTitle: $("setup-guide-title"), setupGuideSubtitle: $("setup-guide-subtitle"),
  setAutoUpdate: $("set-auto-update"), updateAutoLabel: $("update-auto-label"), updateStatusCopy: $("update-status-copy"), updateCheck: $("update-check"), updateCheckLabel: $("update-check-label"), updateCheckStatus: $("update-check-status"), updateAllDevices: $("update-all-devices"), updateCenterSummary: $("update-center-summary"), updateDeviceList: $("update-device-list"),
  syncBaseDevice: $("sync-base-device"), syncCompareDevice: $("sync-compare-device"), syncCompare: $("sync-compare"), syncCompareStatus: $("sync-compare-status"), syncResult: $("sync-result"),
  setLocale: $("set-locale"), setTheme: $("set-theme"), setDesignTheme: $("theme-choices"), setSidebarWidth: $("set-sidebar-width"), setSidebarWidthValue: $("set-sidebar-width-value"), setFontScale: $("set-font-scale"), setFontScaleValue: $("set-font-scale-value"), setCompact: $("set-compact"), setGroup: $("set-group"),
  btnImg: $("btn-img"), fileInput: $("file-input"), imgPreview: $("img-preview"),
  setReducedMotion: $("set-reduced-motion"), setThinking: $("set-thinking"),
  modelVisibilityList: $("model-visibility-list"), modelVisibilityRefresh: $("model-visibility-refresh"),
  providerConfigExport: $("provider-config-export"), providerConfigImport: $("provider-config-import"),
  pushToggle: $("push-toggle"),
  usageSummaryCard: $("usage-summary-card"), usageSummaryRows: $("usage-summary-rows"), usageSummaryNote: $("usage-summary-note"),
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
  newDialog: $("new-dialog"), newCwd: $("new-cwd"), newName: $("new-name"), newAgent: $("new-agent"), newWorktree: $("new-worktree"), newAgentNote: $("new-agent-note"),
  newCancel: $("new-cancel"), newStart: $("new-start"), newFolderUp: $("new-folder-up"),
  newFolderHome: $("new-folder-home"), newFolderPath: $("new-folder-path"), newFolderList: $("new-folder-list"),
  saSheet: $("session-action-sheet"), saTitle: $("sa-title"),
  saModel: $("sa-model"), saRename: $("sa-rename"), saDelete: $("sa-delete"), saExport: $("sa-export"), saCancel: $("sa-cancel"),
  projectActionSheet: $("project-action-sheet"), projectActionTitle: $("pa-title"),
  projectActionPin: $("pa-pin"), projectActionEdit: $("pa-edit"), projectActionReveal: $("pa-reveal"),
  projectActionWorktree: $("pa-worktree"), projectActionArchive: $("pa-archive"), projectActionRemove: $("pa-remove"),
  projectActionCancel: $("pa-cancel"), projectActionClose: $("pa-cancel-close"),
  modelSheet: $("model-sheet"), modelList: $("model-list"), modelSearch: $("model-search"),
  commandPalette: $("command-palette"), commandInput: $("command-input"), commandResults: $("command-results"),
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
  extensionUiStatus: $("extension-ui-status"),
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
let agentCatalog = [];
let agentCatalogError = false;
let claudeAuthClient = null;
let agentTasks = [];
let agentTaskPollTimer = null;
let agentHubTicker = null;
let agentCatalogRequest = null;
let currentAgentTaskId = null;
const collapsedProjects = new Set();
const expandedProjectSessions = new Set();
const PROJECT_SESSION_PREVIEW_LIMIT = 3;
let rpc = null;              // {sid, es, streaming, queued}
let pendingAssistant = null;
let liveToolCards = new Map();
let liveActivity = null;     // 目前工作輪次的整組 thinking／tool 紀錄
let activeActivityRun = null; // one logical run; may span retry/compaction agent_start events
let taskProgress = null;     // latest extension/plan task widget shown above the composer
const extensionStatuses = new Map();
const TASK_WIDGET_KEY_RE = /(?:plan|todo|task|progress|step)/i;
let settings = loadSettings();
const DRAFT_STORAGE_KEY = "stepsemble.composer-drafts.v1";
const LEGACY_DRAFT_STORAGE_KEYS = Object.freeze(["piharbor.composer-drafts.v1", "piweb.composer-drafts.v1"]);
let activeDraftKey = "";
let composerModelName = "";
let composerReasoningLevel = "off";
let modelCatalog = [];
let configuredProviders = [];
let providerCatalog = [];
let providerCatalogLoading = false;
let providerCatalogRequest = null;
let providerCatalogReadOnly = false;
let providerCatalogNotice = "";

function readDraftEntries() {
  try { return normalizeDraftEntries(migratedStorageValue(localStorage, DRAFT_STORAGE_KEY, LEGACY_DRAFT_STORAGE_KEYS)); }
  catch { return []; }
}

function writeDraftEntries(entries) {
  try {
    const normalized = normalizeDraftEntries(entries);
    if (normalized.length) localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(normalized));
    else localStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {}
}

function saveDraftForKey(key, text) {
  if (!key) return;
  writeDraftEntries(updateDraftEntries(readDraftEntries(), key, text));
}

function removeDraftForKey(key) {
  if (!key) return;
  writeDraftEntries(updateDraftEntries(readDraftEntries(), key, ""));
}

function saveActiveDraft() {
  if (activeDraftKey) saveDraftForKey(activeDraftKey, el.input.value);
}

function resizeComposerInput() {
  el.input.style.height = "auto";
  if (el.input.value) el.input.style.height = Math.min(el.input.scrollHeight, 120) + "px";
}

function beginDraftScope(scope) {
  saveActiveDraft();
  activeDraftKey = draftScopeKey(selectedId || selfId || "local", scope);
  el.input.value = draftTextForKey(readDraftEntries(), activeDraftKey);
  resizeComposerInput();
  // Commands are session-specific; never show the previous session's menu
  // while the replacement RPC is still connecting.
  el.slashMenu.classList.add("hidden");
  slashState = null;
}

function clearDraftScopeForDeviceSwitch() {
  saveActiveDraft();
  activeDraftKey = "";
  el.input.value = "";
  resizeComposerInput();
}

function promoteDraftScope(file) {
  if (!activeDraftKey || !file) return;
  const nextKey = draftScopeKey(selectedId || selfId || "local", { file });
  if (nextKey === activeDraftKey) return;
  const previousKey = activeDraftKey;
  const text = el.input.value;
  activeDraftKey = nextKey;
  removeDraftForKey(previousKey);
  if (text.trim()) saveDraftForKey(nextKey, text);
}
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
let machinePairPreview = null;
let machinePairReviewRequest = 0;
let incomingGrants = null;
let incomingGrantsError = "";
let incomingGrantsRemoteError = false;
let incomingGrantsMachine = null;
let incomingGrantsRequest = null;
let incomingGrantsAbort = null;
let incomingGrantsRefreshAt = 0;
let incomingGrantsState = "idle";
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
let sessionUsage = { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
let sessionUsageFooter = null;
const CONTEXT_RING_RADIUS = 15.5;
const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_RING_RADIUS;
let composerModelContextWindow = null;
let contextStats = null;
let contextStatsState = "awaiting"; // awaiting | ready | unavailable
let contextStatsRequest = null;
let contextStatsRequestSequence = 0;
let extensionUiRequest = null;
const nativeDialogs = new StepsembleDialogs.Queue();
let activityWatchdog = null;
let runTimerInterval = null;
let expandedPinnedSessions = false;
const ONBOARDING_KEY = "stepsemble.onboarding.v1";
const LEGACY_ONBOARDING_KEYS = Object.freeze(["piharbor.onboarding.v1", "piweb.onboarding.v1"]);
let onboardingStep = 0;
const ACTIVITY_STALE_MS = 45_000;
let projectChangesState = null;
let projectChangesRequest = null;
let projectDiffRequest = null;
let selectedChangePath = "";
let projectChangesShouldResetScroll = true;

// Device discovery is deliberately independent from apiBase.  apiBase may
// still point at a remote machine while the authoritative catalog always
// comes from this browser's signed-in Stepsemble instance.
const MACHINE_CATALOG_RETRY_DELAYS = Object.freeze([120, 320]);
let machineCatalogRequest = null;
let machineCatalogStatus = "idle";

// ===========================================================================
// Toast
// ===========================================================================

function toast(msg, isError = false, action = null) {
  const t = document.createElement("div");
  t.className = "toast" + (isError ? " err" : "");
  t.textContent = msg;
  if (action?.label && typeof action.run === "function") {
    // Undo-style toasts live longer and carry their own action button, so a
    // reversible step replaces a blocking confirm().
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => { t.remove(); action.run(); });
    t.appendChild(btn);
  }
  el.toastWrap.appendChild(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 350); }, action ? 7000 : 2400);
}

// ===========================================================================
// 任務進度（Pi extension widget / Plan 文字的 web 呈現）
// ===========================================================================

function taskProgressText(key, vars = {}) {
  return tKey(`taskProgress.${key}`, vars);
}

function taskProgressCountFromStatus(value) {
  const match = String(value || "").match(/(\d{1,4})\s*(?:\/|of)\s*(\d{1,4})/i);
  if (!match) return null;
  const completed = Math.max(0, Number(match[1]) || 0);
  const total = Math.max(completed, Number(match[2]) || 0);
  return total > 0 ? { completed: Math.min(completed, total), total } : null;
}

function taskProgressStats(state) {
  const items = Array.isArray(state?.items) ? state.items : [];
  const statusCount = taskProgressCountFromStatus(state?.statusText);
  const total = items.length || statusCount?.total || Math.max(0, Number(state?.statusTotal) || 0);
  const completed = items.length
    ? items.filter((item) => item?.completed).length
    : Math.min(total, statusCount?.completed ?? Math.max(0, Number(state?.statusCompleted) || 0));
  return { items, completed: Math.min(completed, total), total };
}

function taskProgressActiveIndex(state) {
  const { items } = taskProgressStats(state);
  return items.findIndex((item) => !item?.completed);
}

function taskProgressIsRunning(state) {
  const { items, completed, total } = taskProgressStats(state);
  return !!state?.running && (!total || completed < total || !items.length);
}

function taskProgressActivityLabel() {
  const runningCard = [...liveToolCards.values()].find((card) => card.classList.contains("running"));
  if (runningCard) return toolTitle(runningCard.__tool?.name, runningCard.__tool?.args, true);
  if (liveActivity?.running && liveActivity.latest) return liveActivity.latest;
  return activityStatusText(rpc?.activityLabel || "working");
}

function taskProgressFocusActivity(index) {
  const groups = [...(el.messages?.querySelectorAll?.(".activity-group") || [])];
  if (!groups.length) return;
  const activeIndex = taskProgressActiveIndex(taskProgress);
  let target = index === activeIndex
    ? groups.find((group) => group.classList.contains("running")) || groups[groups.length - 1]
    : groups[index] || null;
  if (!target) return;
  target.open = true;
  try {
    target.scrollIntoView({ behavior: settings.reducedMotion ? "auto" : "smooth", block: "nearest" });
  } catch {}
}

function selectTaskProgressStep(index) {
  if (!taskProgress || !Number.isInteger(index) || !taskProgress.items?.[index]) return;
  taskProgress.selectedIndex = index;
  taskProgress.expanded = true;
  renderTaskProgress();
  taskProgressFocusActivity(index);
}

function renderTaskProgress() {
  const root = el.taskProgress;
  if (!root) return;
  const state = taskProgress;
  const { items, completed, total } = taskProgressStats(state);
  const notes = Array.isArray(state?.notes) ? state.notes : [];
  const visible = !!state && (items.length > 0 || notes.length > 0 || total > 0);
  root.classList.toggle("hidden", !visible);
  if (!visible) {
    el.taskProgressPanel?.classList.add("hidden");
    return;
  }

  const running = taskProgressIsRunning(state);
  const complete = total > 0 && completed >= total;
  root.dataset.state = running ? "running" : complete ? "complete" : "idle";
  root.classList.toggle("running", running);
  if (el.taskProgressHeading) el.taskProgressHeading.textContent = taskProgressText("title");
  if (el.taskProgressState) el.taskProgressState.textContent = running
    ? taskProgressText("running")
    : complete ? taskProgressText("completed") : "";
  if (el.taskProgressCount) {
    el.taskProgressCount.textContent = total
      ? taskProgressText("count", { done: completed, total })
      : taskProgressText("details");
  }
  if (el.taskProgressIndicator) {
    el.taskProgressIndicator.className = "task-progress-indicator"
      + (running ? " running" : complete ? " done" : "");
    el.taskProgressIndicator.replaceChildren();
    if (complete && !running) {
      el.taskProgressIndicator.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-check"></use></svg>';
    }
  }
  if (el.taskProgressToggle) {
    const expanded = !!state.expanded;
    el.taskProgressToggle.setAttribute("aria-expanded", String(expanded));
    const action = expanded ? taskProgressText("collapse") : taskProgressText("expand");
    el.taskProgressToggle.title = action;
    el.taskProgressToggle.setAttribute("aria-label", `${action}: ${el.taskProgressCount?.textContent || taskProgressText("details")}`);
  }
  el.taskProgressPanel?.classList.toggle("hidden", !state.expanded);
  if (el.taskProgressList) {
    el.taskProgressList.replaceChildren();
    const activeIndex = taskProgressActiveIndex(state);
    const selectedIndex = Number.isInteger(state.selectedIndex) && state.selectedIndex >= 0 && state.selectedIndex < items.length
      ? state.selectedIndex : (activeIndex >= 0 ? activeIndex : items.length - 1);
    if (Number.isInteger(state.selectedIndex) && state.selectedIndex !== selectedIndex) state.selectedIndex = selectedIndex;
    items.forEach((item, index) => {
      const done = !!item.completed;
      const active = !done && running && index === activeIndex;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "task-progress-step" + (done ? " done" : active ? " active" : " pending")
        + (index === selectedIndex ? " selected" : "");
      button.setAttribute("aria-current", active ? "step" : "false");
      button.setAttribute("aria-label", `${index + 1}. ${item.text}`);
      const marker = document.createElement("span");
      marker.className = "task-progress-step-marker" + (done ? " done" : active ? " running" : " pending");
      marker.setAttribute("aria-hidden", "true");
      if (done) marker.innerHTML = '<svg class="icon"><use href="#i-check"></use></svg>';
      const number = document.createElement("span");
      number.className = "task-progress-step-number";
      number.textContent = `${index + 1}.`;
      const copy = document.createElement("span");
      copy.className = "task-progress-step-copy";
      copy.textContent = item.text;
      button.append(marker, number, copy);
      button.addEventListener("click", () => selectTaskProgressStep(index));
      el.taskProgressList.appendChild(button);
    });
  }
  if (el.taskProgressDetail) {
    const activeIndex = taskProgressActiveIndex(state);
    const selectedIndex = Number.isInteger(state.selectedIndex) && state.selectedIndex >= 0 && state.selectedIndex < items.length
      ? state.selectedIndex : (activeIndex >= 0 ? activeIndex : items.length - 1);
    const item = items[selectedIndex];
    if (!item) {
      el.taskProgressDetail.textContent = "";
      el.taskProgressDetail.classList.add("hidden");
    } else {
      const status = item.completed
        ? taskProgressText("completed")
        : selectedIndex === activeIndex && running
          ? `${taskProgressText("current")}: ${taskProgressActivityLabel()}`
          : taskProgressText("upNext");
      el.taskProgressDetail.textContent = `${status} · ${item.text}`;
      el.taskProgressDetail.classList.remove("hidden");
    }
  }
  if (el.taskProgressNotes) {
    el.taskProgressNotes.replaceChildren();
    for (const note of notes) {
      const copy = document.createElement("p");
      copy.textContent = note;
      el.taskProgressNotes.appendChild(copy);
    }
  }
  root.setAttribute("aria-label", `${taskProgressText("title")}${total ? ` · ${completed}/${total}` : ""}`);
}

function resetTaskProgress() {
  taskProgress = null;
  extensionStatuses.clear();
  renderTaskProgress();
}

function setTaskProgressRunState(running) {
  if (!taskProgress) return;
  taskProgress.running = !!running;
  if (running) {
    taskProgress.settled = false;
    // A widget is normally restored during session_start, before the next
    // agent_start flips the RPC into its running state. Open it automatically
    // for that first live run; a user can still collapse it afterwards.
    if (taskProgress.items?.length) taskProgress.expanded = true;
  }
  renderTaskProgress();
}

function settleTaskProgress() {
  if (!taskProgress) return;
  taskProgress.running = false;
  taskProgress.settled = true;
  const { completed, total } = taskProgressStats(taskProgress);
  if (total > 0 && completed >= total) taskProgress.expanded = false;
  renderTaskProgress();
}

function taskProgressStatusTextFor(key) {
  const exact = extensionStatuses.get(key);
  if (exact) return exact;
  for (const [statusKey, statusText] of extensionStatuses) {
    if (TASK_WIDGET_KEY_RE.test(statusKey) && statusText) return statusText;
  }
  return "";
}

function setTaskProgressWidget(key, lines) {
  const widgetKey = String(key || "").trim();
  if (!widgetKey) return;
  if (lines === undefined || lines === null) {
    if (taskProgress?.key !== widgetKey) return;
    if (taskProgress.items?.length) {
      taskProgress.running = false;
      taskProgress.settled = true;
      const { completed, total } = taskProgressStats(taskProgress);
      if (total > 0 && completed >= total) taskProgress.expanded = false;
      renderTaskProgress();
    } else {
      resetTaskProgress();
    }
    return;
  }
  if (!Array.isArray(lines)) return;
  const parsed = parseTaskProgressLines(lines, { allowPlain: TASK_WIDGET_KEY_RE.test(widgetKey) });
  if (!TASK_WIDGET_KEY_RE.test(widgetKey) && !parsed.items.length) return;
  const previous = taskProgress;
  const sameWidget = previous?.key === widgetKey && previous?.source === "widget";
  const statusText = taskProgressStatusTextFor(widgetKey);
  const statusCount = taskProgressCountFromStatus(statusText);
  taskProgress = {
    key: widgetKey,
    source: "widget",
    items: parsed.items,
    notes: parsed.notes,
    statusText,
    statusCompleted: statusCount?.completed ?? null,
    statusTotal: statusCount?.total ?? null,
    expanded: sameWidget ? !!previous.expanded : !!(rpc?.streaming && parsed.items.length),
    selectedIndex: sameWidget ? previous.selectedIndex : null,
    running: !!rpc?.streaming,
    settled: false,
  };
  renderTaskProgress();
}

function setTaskProgressStatus(key, value) {
  const statusKey = String(key || "").trim();
  if (!statusKey) return;
  const statusText = stripAnsi(value).replace(/\s+/g, " ").trim().slice(0, 500);
  if (statusText) extensionStatuses.set(statusKey, statusText);
  else extensionStatuses.delete(statusKey);
  if (!taskProgress || (taskProgress.key !== statusKey && !TASK_WIDGET_KEY_RE.test(statusKey))) return;
  taskProgress.statusText = taskProgressStatusTextFor(taskProgress.key || statusKey);
  const statusCount = taskProgressCountFromStatus(taskProgress.statusText);
  taskProgress.statusCompleted = statusCount?.completed ?? null;
  taskProgress.statusTotal = statusCount?.total ?? null;
  renderTaskProgress();
}

function markTaskProgressDone(text) {
  if (!taskProgress?.items?.length) return false;
  let changed = false;
  for (const match of String(text || "").matchAll(/\[DONE:(\d+)\]/gi)) {
    const step = Number(match[1]);
    const item = taskProgress.items.find((candidate, index) => candidate.step === step || index + 1 === step);
    if (item && !item.completed) {
      item.completed = true;
      changed = true;
    }
  }
  if (changed) renderTaskProgress();
  return changed;
}

function updateTaskProgressFromAssistant(text, { running = false } = {}) {
  const value = String(text || "");
  if (!value.trim()) return;
  const plan = extractTaskPlan(value);
  if (plan.length && taskProgress?.source !== "widget") {
    const previous = taskProgress?.source === "history" ? taskProgress : null;
    taskProgress = {
      key: "history-plan",
      source: "history",
      items: plan.map((item) => ({ ...item })),
      notes: [],
      statusText: "",
      statusCompleted: null,
      statusTotal: null,
      expanded: previous ? !!previous.expanded : false,
      selectedIndex: previous ? previous.selectedIndex : null,
      running: !!running,
      settled: false,
    };
  }
  const marked = markTaskProgressDone(value);
  if (plan.length || marked) renderTaskProgress();
}

el.taskProgressToggle?.addEventListener("click", () => {
  if (!taskProgress) return;
  taskProgress.expanded = !taskProgress.expanded;
  renderTaskProgress();
});

// ===========================================================================
// API（apiBase："" 本機 或 "/r/<id>" 反代遠端）
// ===========================================================================

const remoteAuthorizationNoticeAt = new Map();
function remoteMachineIdForBase(base) {
  return String(base || "").match(/^\/r\/([a-z0-9-]+)$/)?.[1] || null;
}

function showRemoteAuthorizationState(base) {
  const machineId = remoteMachineIdForBase(base);
  const machine = machines.find((item) => item.id === machineId) || null;
  const device = machineDisplayName(machine || { name: "Stepsemble device" });
  const message = tKey("deviceTrust.remoteAuthorizationError", { device });
  if (machineId) {
    machineStatuses.set(machineId, "offline");
    const existing = updateDeviceStatuses.get(machineId);
    if (existing) updateDeviceStatuses.set(machineId, {
      ...existing,
      error: Object.assign(new Error(message), { status: 401, remote: true, remoteKey: "deviceTrust.remoteAuthorizationError" }),
      reachable: false,
    });
    renderMachineSwitch();
    renderMachineList();
    if (typeof updateViewIsOpen === "function" && updateViewIsOpen()) renderUpdateCenter();
  }
  const now = Date.now();
  const lastNotice = remoteAuthorizationNoticeAt.get(machineId || base) || 0;
  if (now - lastNotice > 2500) {
    remoteAuthorizationNoticeAt.set(machineId || base, now);
    toast(message, true);
  }
  const error = new Error(message);
  error.status = 401;
  error.remote = true;
  error.remoteKey = "deviceTrust.remoteAuthorizationError";
  error.code = "remote_unauthorized";
  return error;
}

const hostClient = new StepsembleClient.Client({
  onUnauthorized(baseAtStart, requestPath) {
    protocolConnections.reset(baseAtStart);
    if (baseAtStart) return showRemoteAuthorizationState(baseAtStart);
    showLogin();
    const error = new Error("unauthorized");
    error.status = 401;
    error.path = requestPath;
    return error;
  },
});
// Opaque browser-lifetime identity; it is not a native account or an auth grant.
const protocolDeviceId = "web-" + (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2));
const protocolConnections = new StepsembleClient.Connections(hostClient, () => ({
  clientVersion: CLIENT_APP_VERSION, protocolMin: 1, protocolMax: 1,
  platform: "web", deviceId: protocolDeviceId,
  capabilities: ["legacy.http", "pi.native-rpc", "agent.terminal-v1"],
}));
async function api(path, opts = {}) {
  const baseAtStart = apiBase;
  await protocolConnections.ensure(baseAtStart, opts.signal);
  return hostClient.request(baseAtStart, path, opts);
}
const post = (path, body) => api(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

function tKey(key, vars = {}) {
  return window.stepsembleI18n?.tKey?.(key, vars) || window.stepsembleI18n?.t?.(key, vars) || key;
}

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
  window.stepsembleI18n?.setLocale(settings.locale || "en");
  if (claudeAuthClient) renderClaudeAuth(claudeAuthClient.snapshot());
  renderContextDashboard();
}

matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => {
  if (settings.theme === "auto") applyAppearance();
});

// ===========================================================================
// 登入 / 登出
// ===========================================================================

function showLogin() {
  claudeAuthClient?.reset();
  resetAgentHub();
  protocolConnections.reset();
  stopUpdateCenterPolling();
  closeChat(true);
  closeProviderAuthClient();
  el.app.classList.add("hidden");
  el.login.classList.remove("hidden");
  void initLoginOnboarding();
}

// ===========================================================================
// 首次啟用存取密鑰導覽（冷錢包式：本機一次性顯示，確認後不再出現）
// ===========================================================================

let onboardingKey = "";
let onboardingKeyRevealed = false;
let onboardingRequest = 0;

function onboardingLocalized(key) {
  return window.stepsembleI18n?.t(key) || key;
}

function chunkOnboardingKey(value) {
  return String(value).replace(/(.{8})/g, "$1 ").trim();
}

function renderOnboardingKey() {
  if (!el.loginOnboardingKey) return;
  el.loginOnboardingKey.textContent = onboardingKeyRevealed
    ? chunkOnboardingKey(onboardingKey)
    : chunkOnboardingKey("•".repeat(onboardingKey.length));
  el.loginOnboardingKey.classList.toggle("masked", !onboardingKeyRevealed);
  if (el.loginOnboardingReveal) {
    el.loginOnboardingReveal.textContent = onboardingLocalized(onboardingKeyRevealed ? "Hide key" : "Show key");
    el.loginOnboardingReveal.setAttribute("aria-pressed", String(onboardingKeyRevealed));
  }
}

function setOnboardingPanel(visible) {
  // The panel replaces the sign-in form until the user records (or skips) the
  // key, so the form and its help copy stay out of the layout while visible.
  el.loginOnboarding.classList.toggle("hidden", !visible);
  el.loginForm.classList.toggle("hidden", visible);
  const help = document.querySelector(".login-help");
  if (help) help.classList.toggle("hidden", visible);
}

async function initLoginOnboarding() {
  if (!el.loginOnboarding) return;
  const request = ++onboardingRequest;
  el.loginOnboardedHint?.classList.add("hidden");
  setOnboardingPanel(false);
  onboardingKey = "";
  onboardingKeyRevealed = false;
  if (el.loginOnboardingSaved) el.loginOnboardingSaved.checked = false;
  if (el.loginOnboardingUnderstood) el.loginOnboardingUnderstood.checked = false;
  if (el.loginOnboardingContinue) el.loginOnboardingContinue.disabled = true;
  renderOnboardingKey();
  let data = null;
  try {
    const response = await fetch("/api/onboarding/key", { credentials: "same-origin", cache: "no-store" });
    if (response.ok) data = await response.json();
  } catch {}
  if (request !== onboardingRequest) return;
  const key = data && data.eligible && typeof data.key === "string" ? data.key : "";
  if (!key) return;
  onboardingKey = key;
  setOnboardingPanel(true);
}

function finishLoginOnboarding(confirmed) {
  setOnboardingPanel(false);
  onboardingKey = "";
  onboardingKeyRevealed = false;
  if (confirmed) {
    if (el.loginOnboardedHint) {
      el.loginOnboardedHint.textContent = onboardingLocalized("Paste the key you saved to sign in.");
      el.loginOnboardedHint.classList.remove("hidden");
    }
    el.loginToken.focus({ preventScroll: true });
  }
}

el.loginOnboardingReveal?.addEventListener("click", () => {
  onboardingKeyRevealed = !onboardingKeyRevealed;
  renderOnboardingKey();
});

el.loginOnboardingCopy?.addEventListener("click", async () => {
  if (!onboardingKey) return;
  try {
    await navigator.clipboard.writeText(onboardingKey);
    toast(onboardingLocalized("Copied"));
  } catch {
    toast(onboardingLocalized("Copy failed"));
  }
});

function updateOnboardingContinueState() {
  if (el.loginOnboardingContinue) {
    el.loginOnboardingContinue.disabled = !(el.loginOnboardingSaved?.checked && el.loginOnboardingUnderstood?.checked);
  }
}
el.loginOnboardingSaved?.addEventListener("change", updateOnboardingContinueState);
el.loginOnboardingUnderstood?.addEventListener("change", updateOnboardingContinueState);

el.loginOnboardingContinue?.addEventListener("click", async () => {
  if (!el.loginOnboardingContinue || el.loginOnboardingContinue.disabled) return;
  el.loginOnboardingContinue.disabled = true;
  try {
    // A failed confirmation only means the panel may be offered again; the
    // sign-in flow itself is never blocked by it.
    const response = await fetch("/api/onboarding/confirm", { method: "POST", credentials: "same-origin" });
    if (!response.ok) throw new Error(String(response.status));
    finishLoginOnboarding(true);
  } catch {
    el.loginOnboardingContinue.disabled = false;
    toast(onboardingLocalized("Could not save the confirmation; try again"));
  }
});

el.loginOnboardingSkip?.addEventListener("click", () => finishLoginOnboarding(false));

// ---- Token help: per-OS instructions on the sign-in card ----
// The token lives on the computer running Stepsemble, so the host's own
// platform is preselected. The other tabs stay available because this page is
// often read on a phone while the token sits on a desktop.
function tokenHelpOsFromPlatform(platform) {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (typeof platform === "string" && platform) return "linux";
  return null;
}

function selectTokenHelpOs(os) {
  if (!os) return;
  const tabs = document.querySelectorAll("[data-token-os]");
  const panels = document.querySelectorAll("[data-token-os-panel]");
  if (!tabs.length || !panels.length) return;
  for (const tab of tabs) tab.setAttribute("aria-selected", String(tab.dataset.tokenOs === os));
  for (const panel of panels) panel.classList.toggle("hidden", panel.dataset.tokenOsPanel !== os);
}

document.querySelectorAll("[data-token-os]").forEach((tab) => {
  tab.addEventListener("click", () => selectTokenHelpOs(tab.dataset.tokenOs));
});

async function boot() {
  applyAppearance();
  // Machine discovery is protected, so determine auth state first.  In
  // particular, do not let a pre-auth 401 leave an empty catalog behind.
  try {
    const response = await fetch("/api/machine", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error(response.statusText || "Could not read device status");
    const m = await response.json();
    el.loginMachine.textContent = machineDisplayName(m.machine);
    currentHost = m.machine;
    window._piHome = m.home || "";
    selectTokenHelpOs(tokenHelpOsFromPlatform(m.platform));
    if (m.authed) { await enterApp(); return; }
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
    await enterApp();
  } catch (err) {
    el.loginError.textContent = err.message === "unauthorized"
      ? "Token 不正確"
      : err.status === 401 ? (window.stepsembleI18n?.t("登入已過期") || "Sign-in expired") : err.message;
    el.loginError.classList.remove("hidden");
  }
});

function machineCatalogStatusText(key, fallback) {
  return window.stepsembleI18n?.t(key) || fallback;
}

function setMachineCatalogStatus(state, message = "") {
  machineCatalogStatus = state;
  if (!el.machineCatalogStatus || !el.machineCatalogStatusCopy) return;
  const retrying = state === "retrying";
  const failed = state === "error";
  el.machineCatalogStatus.classList.toggle("hidden", state === "idle" || state === "success");
  el.machineCatalogStatus.classList.toggle("error", failed);
  el.machineCatalogStatusCopy.textContent = message || (
    state === "loading" ? machineCatalogStatusText("讀取中…", "Loading devices…")
      : retrying ? tKey("runtime.connectionRetrying")
        : machineCatalogStatusText("目前無法讀取設備清單", "Could not load device list")
  );
  if (el.machineCatalogRetry) {
    el.machineCatalogRetry.classList.toggle("hidden", !failed);
    el.machineCatalogRetry.textContent = machineCatalogStatusText("重試", "Retry");
  }
}

function machineCatalogError(message, status) {
  const error = new Error(message);
  if (status != null) error.status = status;
  return error;
}

function shouldRetryMachineCatalog(error) {
  const status = Number(error?.status);
  return ![401, 403].includes(status)
    && (!Number.isFinite(status) || [408, 425, 429].includes(status) || status >= 500);
}

async function fetchAuthoritativeMachineCatalog() {
  const response = await fetch("/api/machines", {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 401) throw machineCatalogError("unauthorized", 401);
  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok) throw machineCatalogError(data?.error || response.statusText || "Could not load device list", response.status);
  if (!Array.isArray(data?.machines)) throw machineCatalogError("Invalid device list", 502);
  if (!data.machines.length) throw machineCatalogError("Device list is empty", 503);
  return data || {};
}

function applyMachineCatalog(data) {
  const previousSelectedId = selectedId;
  const previousSelfId = selfId;
  const state = resolveMachineCatalogState(data, {
    selectedId,
    savedSelectedId: loadSelected(),
  });
  machines = state.machines;
  selfId = state.selfId;
  selectedId = state.selectedId;
  if (previousSelectedId !== selectedId || previousSelfId !== selfId) {
    resetIncomingGrants();
    resetAgentHub();
  }
  updateDeviceStatuses = new Map([...updateDeviceStatuses].filter(([id]) => machines.some((machine) => machine.id === id)));
  updateStatusData = updateDeviceStatuses.get(selectedId)?.data || null;
  cancelUpdateCenterRequest();
  if (updateAllController) updateAllController.abort();
  updateAllController = null;
  updateAllRequest += 1;
  if (el.updateAllDevices) el.updateAllDevices.disabled = false;
  if (selectedId) saveSelected(selectedId);
  applyApiBase();
  renderMachineSwitch();
  renderMachineList();
  if (!el.viewSettings.classList.contains("hidden")) {
    renderSettings();
    void refreshUpdateCenter(true);
  }
  return state;
}

async function hydrateMachineCatalog({ retry = true } = {}) {
  if (machineCatalogRequest) return machineCatalogRequest;
  machineCatalogRequest = (async () => {
    setMachineCatalogStatus("loading");
    try {
      const data = await foundation.retryWithBackoff(fetchAuthoritativeMachineCatalog, {
        delays: retry ? MACHINE_CATALOG_RETRY_DELAYS : [],
        shouldRetry: shouldRetryMachineCatalog,
        onRetry: () => setMachineCatalogStatus("retrying"),
      });
      const state = applyMachineCatalog(data);
      setMachineCatalogStatus("success");
      return state;
    } catch (error) {
      if (error?.status === 401 || error?.message === "unauthorized") {
        setMachineCatalogStatus("idle");
        showLogin();
      } else {
        setMachineCatalogStatus("error", `${machineCatalogStatusText("目前無法讀取設備清單", "Could not load device list")} · ${machineCatalogStatusText("重試", "Retry")}`);
      }
      throw error;
    }
  })().finally(() => { machineCatalogRequest = null; });
  return machineCatalogRequest;
}

let enterAppRequest = null;
async function enterApp() {
  if (enterAppRequest) return enterAppRequest;
  enterAppRequest = (async () => {
    try {
      // This must settle before the list, version, or onboarding requests run.
      await hydrateMachineCatalog();
    } catch (error) {
      if (error?.status === 401 || error?.message === "unauthorized") throw error;
      // Keep the app usable enough to expose the explicit retry path.  Do not
      // pretend that an empty catalog is a successful first-login state.
      el.login.classList.add("hidden");
      el.app.classList.remove("hidden");
      showListSilent();
      return false;
    }
    el.login.classList.add("hidden");
    el.app.classList.remove("hidden");
    await showList();
    // Discover connector availability once the authenticated machine catalog
    // is ready. The list card and New Project selector then share one snapshot.
    void loadAgentCatalog();
    void refreshAgentTasks();
    void refreshMachineStatuses();
    loadVersion();
    setTimeout(() => openOnboarding(false), 350);
    return true;
  })().finally(() => { enterAppRequest = null; });
  return enterAppRequest;
}

el.machineCatalogRetry?.addEventListener("click", () => { void enterApp().catch(() => {}); });

function loadVersion() {
  const generation = viewGeneration;
  const baseAtStart = apiBase;
  window._piVersion = "…";
  api("/api/version").then(v => {
    if (generation !== viewGeneration || baseAtStart !== apiBase) return;
    window._piVersion = v.version;
    window._appVersion = v.appVersion || CLIENT_APP_VERSION;
    if (!el.viewSettings.classList.contains("hidden")) renderSettings();
  }).catch(() => {});
  api("/api/machine").then(m => {
    if (generation !== viewGeneration || baseAtStart !== apiBase) return;
    currentHost = m.machine || currentHost;
    // Never keep a previous device's home when this response omits it. The
    // project picker intentionally uses a no-path browse request until it has
    // an explicit, validated path, so a stale home can never leak across hosts.
    window._piHome = typeof m.home === "string" ? m.home : "";
    if (!el.viewSettings.classList.contains("hidden")) renderSettings();
  }).catch(() => {});
}

// ---- SPA 機器切換：零頁面跳轉，只切資料源 ----
function applyApiBase() {
  apiBase = selectedId === selfId ? "" : "/r/" + selectedId;
}

function switchMachine(id, silent) {
  if (!machines.some(m => m.id === id)) return;
  claudeAuthClient?.reset();
  resetAgentHub();
  if ($("claude-auth")) $("claude-auth").open = false;
  clearDraftScopeForDeviceSwitch();
  resetProjectChanges();
  stopUpdateCenterPolling();
  cancelProjectFolderRequest();
  const generation = ++viewGeneration;
  const wasChatOpen = !el.viewChat.classList.contains("hidden");
  const preserveRunning = !!(rpc && (rpc.streaming || rpc.connectionLost));
  closeChat(preserveRunning); // 切機器時不殺正在執行的工作，閒置 RPC 則正常關閉
  closeProviderAuthClient(); // Detach locally; never retarget the old Host's login.
  el.viewChat.classList.add("hidden");
  el.viewChat.style.transform = "";
  resetSettingsOverlay();
  el.viewSettings.classList.add("hidden");
  el.viewModelSettings.classList.add("hidden");
  selectedId = id;
  resetIncomingGrants();
  saveSelected(id);
  // Do not let a previous host's home remain authoritative while the new
  // /api/machine response is in flight. The picker still starts no-path.
  window._piHome = "";
  updateStatusData = updateDeviceStatuses.get(id)?.data || null;
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
  cancelModelVisibilityRequest();
  currentSessionFile = null;
  currentSessionCwd = null;
  sessionsCache = [];
  tokenLoadSequence += 1;
  tokenRows = null;
  tokenRowsLoading = false;
  renderTokenList();
  resetComposerSummary();
  updateNewProjectAffordance();
  temporarySessionCount = 0;
  renderTemporarySessionFilter(0);
  renderMachineSwitch();
  showListSilent();
  void generation;
  refreshSessions();
  void loadAgentCatalog();
  void refreshMachineStatuses();
  loadVersion();
  if (!silent) toast(`已切換到 ${machineName(id)}`);
  void wasChatOpen;
}

function showListSilent() {
  el.viewList.classList.remove("hidden");
  el.viewSettings.classList.add("hidden");
  el.viewModelSettings.classList.add("hidden");
  showChatEmpty();
}

// ---- 頂欄機器切換下拉 ----
function machineStatusText(status) {
  const key = status === "online" ? "deviceTrust.statusOnline"
    : status === "offline" ? "deviceTrust.statusOffline"
      : "deviceTrust.statusNotChecked";
  return tKey(key);
}
function machineAuthText(machine) {
  const key = machine?.authMode === "local" ? "deviceTrust.authLocal"
    : machine?.authMode === "dedicated" ? "deviceTrust.authDedicated"
      : machine?.authMode === "unavailable" ? "deviceTrust.authUnavailable" : "deviceTrust.authLegacy";
  return tKey(key);
}
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
  const status = machineStatuses.get(selectedId) || "unknown";
  const statusLabel = machineStatusText(status);
  if (el.machineSwitchStatus) {
    el.machineSwitchStatus.className = `machine-status-dot machine-status-${status}`;
    el.machineSwitchStatus.title = statusLabel;
    el.machineSwitchStatus.dataset.status = status;
  }
  el.machineSwitch.title = `${window.stepsembleI18n?.t("Switch device") || "Switch device"} · ${statusLabel}`;
  el.machineSwitch.setAttribute("aria-label", `${window.stepsembleI18n?.t("Switch device") || "Switch device"}: ${statusLabel}`);
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
// Access tokens（每設備獨立令牌）
// ===========================================================================

let tokenRows = null;
let tokenRowsLoading = false;
let tokenLoadSequence = 0;
let tokenNewValue = "";

function setTokenFormError(message = "") {
  if (!el.tokenFormError) return;
  el.tokenFormError.textContent = message;
  el.tokenFormError.classList.toggle("hidden", !message);
}

function setTokenNewRow(visible) {
  el.tokenNewRow?.classList.toggle("hidden", !visible);
  if (!visible) {
    tokenNewValue = "";
    if (el.tokenNewValueText) el.tokenNewValueText.textContent = "";
  }
}

function tokenDateText(value) {
  if (!value) return tKey("tokens.neverUsed");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat(window.stepsembleI18n?.getLocale?.() || settings.locale || "en", {
      dateStyle: "medium", timeStyle: "short",
    }).format(date);
  } catch { return value; }
}

function renderTokenList() {
  const list = el.tokenList;
  if (!list) return;
  list.innerHTML = "";
  if (tokenRowsLoading) {
    const note = document.createElement("p");
    note.className = "settings-note";
    note.textContent = tKey("tokens.loading");
    list.appendChild(note);
    return;
  }
  if (!tokenRows) {
    const note = document.createElement("p");
    note.className = "settings-note error-text";
    note.textContent = tKey("tokens.error");
    list.appendChild(note);
    return;
  }
  if (!tokenRows.length) {
    const note = document.createElement("p");
    note.className = "settings-note";
    note.textContent = tKey("tokens.empty");
    list.appendChild(note);
    return;
  }
  for (const row of tokenRows) {
    const line = document.createElement("div");
    line.className = "token-row";
    const copy = document.createElement("div");
    copy.className = "token-row-copy";
    const name = document.createElement("strong");
    name.textContent = row.label;
    const detail = document.createElement("small");
    const created = tKey("tokens.created", { date: tokenDateText(row.createdAt) });
    const lastUsed = row.lastUsedAt
      ? tKey("tokens.lastUsed", { date: tokenDateText(row.lastUsedAt) })
      : tKey("tokens.neverUsed");
    detail.textContent = `${created} · ${lastUsed}`;
    copy.append(name, detail);
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "btn ghost danger-text";
    revoke.textContent = tKey("tokens.revoke");
    revoke.addEventListener("click", () => void revokeToken(row, revoke));
    line.append(copy, revoke);
    list.appendChild(line);
  }
}

async function loadTokens(force = false) {
  if (!el.tokenList) return;
  if (tokenRowsLoading || (tokenRows && !force)) { renderTokenList(); return; }
  const request = ++tokenLoadSequence;
  const baseAtStart = apiBase;
  const selectedAtStart = selectedId;
  tokenRowsLoading = true;
  renderTokenList();
  try {
    const data = await api("/api/access-tokens");
    if (request !== tokenLoadSequence || baseAtStart !== apiBase || selectedAtStart !== selectedId) return;
    tokenRows = Array.isArray(data?.tokens) ? data.tokens : [];
  } catch {
    if (request !== tokenLoadSequence || baseAtStart !== apiBase || selectedAtStart !== selectedId) return;
    tokenRows = null;
  }
  if (request !== tokenLoadSequence) return;
  tokenRowsLoading = false;
  renderTokenList();
}

async function createToken() {
  if (!el.tokenCreate) return;
  const label = String(el.tokenLabel?.value || "").trim();
  if (!label) { setTokenFormError(tKey("tokens.labelRequired")); return; }
  el.tokenCreate.disabled = true;
  setTokenFormError();
  try {
    const result = await post("/api/access-tokens/create", { label });
    tokenNewValue = String(result?.token || "");
    if (el.tokenNewValueText) el.tokenNewValueText.textContent = tokenNewValue;
    if (el.tokenLabel) el.tokenLabel.value = "";
    el.tokenCreateRow?.classList.add("hidden");
    setTokenNewRow(true);
    await loadTokens(true);
  } catch (error) {
    setTokenFormError(error.status === 409 ? tKey("tokens.limit") : (error.message || tKey("tokens.error")));
  } finally {
    el.tokenCreate.disabled = false;
  }
}

async function revokeToken(row, button) {
  if (!row?.id) return;
  if (!window.confirm(tKey("tokens.revokeConfirm", { label: row.label }))) return;
  button.disabled = true;
  try {
    await post("/api/access-tokens/revoke", { id: row.id });
    toast(tKey("tokens.revoked"));
    await loadTokens(true);
  } catch (error) {
    button.disabled = false;
    setTokenFormError(error.message || tKey("tokens.error"));
  }
}

el.tokenAdd?.addEventListener("click", () => {
  setTokenNewRow(false);
  el.tokenCreateRow?.classList.toggle("hidden");
  if (!el.tokenCreateRow?.classList.contains("hidden")) el.tokenLabel?.focus();
});
el.tokenCreateCancel?.addEventListener("click", () => {
  el.tokenCreateRow?.classList.add("hidden");
  setTokenFormError();
});
el.tokenCreate?.addEventListener("click", () => void createToken());
el.tokenLabel?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); void createToken(); }
});
el.tokenNewCopy?.addEventListener("click", async () => {
  try { await copyText(tokenNewValue); toast(tKey("tokens.copied")); }
  catch { toast(tKey("tokens.copyFailed"), true); }
});
el.tokenNewDone?.addEventListener("click", () => {
  tokenNewValue = "";
  setTokenNewRow(false);
});

// ===========================================================================
// 視圖切換
// ===========================================================================

function isDesktop() { return matchMedia("(min-width: 980px)").matches; }

function showList(options = {}) {
  saveActiveDraft();
  resetProjectChanges();
  currentSessionCwd = null;
  stopUpdateCenterPolling();
  ++viewGeneration;
  const wasStreaming = !!(rpc && (rpc.streaming || rpc.connectionLost));
  closeChat(wasStreaming); // streaming 中保留進程繼續跑；閒置對話離開時關閉
  showChatEmpty();
  if (!isDesktop()) el.viewChat.classList.add("hidden");
  el.viewChat.style.transform = "";
  resetSettingsOverlay();
  el.viewSettings.classList.add("hidden");
  el.viewModelSettings.classList.add("hidden");
  el.viewList.classList.remove("hidden");
  return options?.refresh === false ? Promise.resolve() : refreshSessions();
}
el.btnBack.addEventListener("click", showList);

function showChatEmpty() {
  el.viewChat.classList.add("chat-is-empty");
  el.chatTitle.textContent = "Stepsemble";
  el.chatSub.textContent = "";
  el.chatSub.dataset.base = "";
  el.messages.innerHTML = '';
  resetSessionUsage();
  if (el.chatEmpty) {
    el.messages.appendChild(el.chatEmpty);
    el.chatEmpty.classList.remove("hidden");
  }
}
function hideChatEmpty() {
  el.viewChat.classList.remove("chat-is-empty");
  if (el.chatEmpty && el.chatEmpty.parentElement) el.chatEmpty.remove();
}

let settingsSwipeTimer = null;
let settingsSlideTimer = null;
let settingsSwipeCancel = null;

function resetSettingsOverlay() {
  settingsSwipeCancel?.();
  if (settingsSwipeTimer) clearTimeout(settingsSwipeTimer);
  if (settingsSlideTimer) clearTimeout(settingsSlideTimer);
  settingsSwipeTimer = null;
  settingsSlideTimer = null;
  el.viewSettings.classList.remove("dragging", "snap-back", "slide-out", "slide-in");
  el.viewSettings.style.transform = "";
}

function cancelModelVisibilityRequest() {
  if (modelCatalogRequest) modelCatalogRequest.abort();
  modelCatalogRequest = null;
  modelCatalogLoading = false;
  if (el.modelVisibilityRefresh) el.modelVisibilityRefresh.disabled = false;
}

// Every way out of Settings uses this path. Apart from making the toolbar and
// edge gesture equivalent, it cancels late model/status work before restoring
// the session list underneath the overlay.
function hideSettings() {
  settingsSwipeCancel?.();
  stopUpdateCenterPolling();
  cancelModelVisibilityRequest();
  resetIncomingGrants();
  resetResourceSync();
  resetSettingsOverlay();
  el.viewSettings.classList.add("hidden");
  el.viewModelSettings.classList.add("hidden");
  el.viewList.classList.remove("hidden");
}

// ---- 本機用量統計（Settings → About）：最近 7 天的 token／成本條列。
function fmtCompactTokens(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

// The usage card is also a useful canary for a stale PWA shell: older clients
// can keep the old keyed heading or an unstyled rows container after a deploy.
// Normalize the small bit of DOM we own before every render so a reconnect or
// a late locale change cannot leave the card with a raw `usage.title` key or
// stretched rows.
function usageSummaryTitleText() {
  const keyed = tKey("usage.title");
  if (keyed && keyed !== "usage.title") return keyed;
  return window.stepsembleI18n?.t?.("Usage · last 7 days") || "Usage · last 7 days";
}

function normalizeUsageSummaryDom() {
  if (!el.usageSummaryCard || !el.usageSummaryRows) return;
  const title = el.usageSummaryCard.querySelector(
    "#usage-summary-title, [data-i18n-key=\"usage.title\"], .usage-summary-heading strong",
  );
  if (title) {
    title.textContent = usageSummaryTitleText();
    title.dataset.i18nKeyRendered = title.textContent;
  }
  el.usageSummaryRows.classList.add("usage-summary-rows");
  el.usageSummaryRows.setAttribute("role", "list");
}

async function renderUsageSummary() {
  if (!el.usageSummaryCard || !el.usageSummaryRows) return;
  normalizeUsageSummaryDom();
  try {
    const data = await api("/api/usage-summary?days=7");
    normalizeUsageSummaryDom();
    const days = Array.isArray(data?.days) ? data.days : [];
    const maxTokens = Math.max(1, ...days.map((d) => Number(d.tokens) || 0));
    el.usageSummaryRows.innerHTML = "";
    let visible = 0;
    for (const day of days) {
      const tokens = Number(day.tokens) || 0;
      if (tokens > 0) visible++;
      const row = document.createElement("div");
      row.className = "usage-summary-row" + (tokens ? "" : " empty");
      row.setAttribute("role", "listitem");
      const label = document.createElement("span");
      label.className = "usage-day";
      label.textContent = day.date.slice(5);
      const bar = document.createElement("span");
      bar.className = "usage-bar";
      const fill = document.createElement("span");
      fill.className = "usage-bar-fill";
      fill.style.width = (tokens ? Math.max(3, Math.round((tokens / maxTokens) * 100)) : 0) + "%";
      bar.appendChild(fill);
      const value = document.createElement("span");
      value.className = "usage-value";
      const cost = Number(day.cost) || 0;
      value.textContent = tokens ? `${fmtCompactTokens(tokens)} tok${cost ? " · $" + cost.toFixed(2) : ""}` : "—";
      row.append(label, bar, value);
      el.usageSummaryRows.appendChild(row);
    }
    el.usageSummaryCard.classList.toggle("hidden", visible === 0);
    if (el.usageSummaryNote) {
      el.usageSummaryNote.textContent = visible ? "" : window.stepsembleI18n?.t("No usage in the last 7 days") || "No usage in the last 7 days";
    }
  } catch {
    el.usageSummaryCard?.classList.add("hidden");
  }
}

function showSettings() {
  void loadTokens(true);
  resetSettingsOverlay();
  el.viewModelSettings.classList.add("hidden");
  el.viewList.classList.remove("hidden");
  // Render after the settings view is visible so remote trust/status loaders
  // are not discarded by their visibility guard on the first open.
  el.viewSettings.classList.remove("hidden");
  renderSettings();
  void loadModelVisibility();
  void renderUsageSummary();
  el.viewSettings.classList.add("slide-in");
  settingsSlideTimer = setTimeout(() => {
    settingsSlideTimer = null;
    el.viewSettings.classList.remove("slide-in");
  }, 250);
  startUpdateCenterPolling();
}
el.btnOpenSettings.addEventListener("click", showSettings);
el.btnSettingsBack.addEventListener("click", hideSettings);
el.syncCompare?.addEventListener("click", () => { void compareResources(); });

// The settings content owns the scroll position, but the fixed top bar is
// intentionally outside that scroller. Forward desktop wheel gestures that
// start on the bar or an empty overlay edge so the page never feels stuck;
// native form controls keep their own wheel behaviour.
function forwardSettingsWheel(event) {
  const scroll = event.currentTarget?.querySelector?.(".settings-scroll");
  if (!scroll || event.target?.closest?.("select, input, textarea, button")) return;
  if (event.target?.closest?.(".settings-scroll")) return;
  const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * window.innerHeight : event.deltaY;
  if (!Number.isFinite(delta) || delta === 0 || scroll.scrollHeight <= scroll.clientHeight) return;
  scroll.scrollTop += delta;
  event.preventDefault();
}
el.viewSettings?.addEventListener("wheel", forwardSettingsWheel, { passive: false });
el.viewModelSettings?.addEventListener("wheel", forwardSettingsWheel, { passive: false });
function showModelSettings() {
  stopUpdateCenterPolling();
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
  startUpdateCenterPolling();
});

// ===========================================================================
// Session 列表 + 下拉刷新 + 長按動作
// ===========================================================================

// A wedged pi process keeps its streaming flag up with no browser attached;
// surface those runs in the sidebar with a one-tap force stop so users never
// need raw API calls to unblock auto-updates.
async function refreshStuckSessions() {
  if (!el.stuckSessions) return;
  try {
    const data = await api("/api/rpcs");
    const stuck = (Array.isArray(data?.rpcs) ? data.rpcs : []).filter((rpc) => rpc.stuck);
    el.stuckSessions.classList.toggle("hidden", !stuck.length);
    el.stuckSessions.innerHTML = "";
    for (const rpc of stuck) {
      const row = document.createElement("div");
      row.className = "stuck-session-row";
      const copy = document.createElement("span");
      copy.className = "stuck-session-copy";
      const label = document.createElement("strong");
      label.textContent = window.stepsembleI18n?.t("Stuck sessions") || "Stuck sessions";
      const detail = document.createElement("small");
      detail.textContent = rpc.cwd || (rpc.sessionFile || "").split("/").pop() || rpc.sid.slice(0, 8);
      copy.append(label, detail);
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "stuck-session-stop";
      stop.textContent = window.stepsembleI18n?.t("Force stop") || "Force stop";
      stop.addEventListener("click", async () => {
        stop.disabled = true;
        try {
          await post("/api/close", { sid: rpc.sid });
          toast(window.stepsembleI18n?.t("Stuck run closed") || "Stuck run closed");
          refreshStuckSessions();
        } catch (error) {
          toast(error.message || "Could not stop", true);
          stop.disabled = false;
        }
      });
      row.append(copy, stop);
      el.stuckSessions.appendChild(row);
    }
  } catch {
    el.stuckSessions.classList.add("hidden");
  }
}

// ===========================================================================
// Agent Hub — connector inventory + cross-agent task inbox
// ===========================================================================

const AGENT_STATUS_LABELS = Object.freeze({
  starting: "Starting",
  running: "Working",
  reconnecting: "Reconnecting",
  waiting: "Waiting",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
  detached: "Detached",
  orphaned: "Interrupted",
});

function agentHubText(key, vars = {}) {
  const translated = tKey(`agentHub.${key}`, vars);
  if (translated !== `agentHub.${key}`) return translated;
  const fallback = {
    title: "Agent Hub",
    discovering: "Discovering local agents…",
    unavailable: "Could not refresh agents. Try Refresh agents.",
    refresh: "Refresh agents",
    viewAll: "View all",
    close: "Close",
    taskCenterTitle: "Task center",
    taskSearch: "Search tasks…",
    taskFilter: "Filter tasks",
    filterAll: "All",
    filterActive: "Active",
    taskCenterEmpty: "No tasks match this view.",
    taskCenterCount: "{visible} of {total} tasks",
    taskOpen: "Open",
    taskStop: "Stop",
    taskStopping: "Stopping…",
    taskStoppedToast: "Agent task stopped",
    taskStopFailed: "Could not stop agent task",
    taskNoOutput: "No output yet",
    taskLastActivity: "Updated {value}",
    reconnectingNote: "Reconnecting to the supervisor…",
    activeSummary: "{active} active · {ready} ready",
    readySummary: "{ready} agents ready",
    noTasks: "No active tasks — choose an Agent when you start a project.",
    notInstalled: "not installed",
    isolated: "Isolated worktree",
    piNote: "Pi Agent keeps full session history. CLI agents stream terminal output here.",
    cliNote: "This CLI streams terminal output here; the task keeps running when you leave the chat.",
    cliTextOnly: "CLI agents currently accept text input only.",
    agentTask: "Agent task",
    signal: "signal {value}",
    exitCode: "code {value}",
    working: "Working",
    waiting: "Waiting",
    done: "Done",
    failed: "Failed",
    stopped: "Stopped",
    detached: "Detached",
    interrupted: "Interrupted",
    starting: "Starting",
  }[key] || key;
  return String(fallback).replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? `{${name}}`);
}

function agentStatusText(status) {
  const key = String(status || "").toLowerCase();
  return agentHubText(key in AGENT_STATUS_LABELS ? key : "waiting");
}

function agentTaskIsRunning(task) {
  return ["starting", "running", "reconnecting"].includes(String(task?.status || ""));
}

function agentTaskElapsed(task) {
  const start = Number(task?.startedAt);
  if (!Number.isFinite(start) || start <= 0) return "";
  const end = agentTaskIsRunning(task) ? Date.now() : Number(task?.endedAt) || Date.now();
  return runElapsedText(Math.max(0, end - start));
}

function renderAgentHub() {
  if (!el.agentHubCard) return;
  const connectors = Array.isArray(agentCatalog) ? agentCatalog : [];
  const ready = connectors.filter((item) => item.installed).length;
  const active = agentTasks.filter(agentTaskIsRunning).length;
  if (el.agentHubTitle) el.agentHubTitle.textContent = agentHubText("title");
  if (el.agentHubSummary) {
    el.agentHubSummary.textContent = agentCatalogError ? agentHubText("unavailable") : connectors.length
      ? (active ? agentHubText("activeSummary", { active, ready }) : agentHubText("readySummary", { ready }))
      : agentHubText("discovering");
  }
  if (el.agentHubRefresh) {
    el.agentHubRefresh.title = agentHubText("refresh");
    el.agentHubRefresh.setAttribute("aria-label", agentHubText("refresh"));
  }
  if (el.agentHubConnectors) {
    el.agentHubConnectors.replaceChildren();
    for (const connector of connectors) {
      const chip = document.createElement("span");
      chip.className = "agent-connector-chip" + (connector.installed ? " installed" : "");
      chip.title = connector.installed ? (connector.description || connector.label) : `${connector.label} · ${agentHubText("notInstalled")}`;
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = connector.label || connector.id;
      label.dataset.i18nIgnore = "";
      chip.append(dot, label);
      el.agentHubConnectors.appendChild(chip);
    }
  }
  if (!el.agentTaskList) return;
  el.agentTaskList.replaceChildren();
  const visible = [...agentTasks].sort((a, b) => {
    const activeOrder = Number(agentTaskIsRunning(b)) - Number(agentTaskIsRunning(a));
    return activeOrder || (Number(b.lastActivityAt || b.startedAt) || 0) - (Number(a.lastActivityAt || a.startedAt) || 0);
  }).slice(0, 5);
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "agent-hub-empty";
    empty.textContent = agentHubText("noTasks");
    el.agentTaskList.appendChild(empty);
    return;
  }
  for (const task of visible) {
    const row = document.createElement("button");
    row.type = "button";
    const taskStatus = String(task.status || "").replace(/[^a-z0-9_-]/gi, "");
    row.className = `agent-task-row ${agentTaskIsRunning(task) ? "running" : ""} ${taskStatus}`.trim();
    row.dataset.taskId = task.id || task.taskId || "";
    const dot = document.createElement("span");
    dot.className = "agent-task-dot";
    dot.setAttribute("aria-hidden", "true");
    const copy = document.createElement("span");
    copy.className = "agent-task-copy";
    const name = document.createElement("strong");
    name.textContent = task.agentId === "pi" ? sessionDisplayTitle(task) : task.name || task.agent || agentHubText("agentTask");
    name.dataset.i18nIgnore = "";
    const detail = document.createElement("small");
    detail.textContent = `${task.agentId === "pi" ? "Pi Agent" : (connectors.find((item) => item.id === task.agentId)?.label || task.agentId || "Agent")} · ${task.cwd || ""}`;
    detail.dataset.i18nIgnore = "";
    copy.append(name, detail);
    const state = document.createElement("span");
    state.className = "agent-task-state";
    state.textContent = agentTaskElapsed(task) ? `${agentStatusText(task.status)} · ${agentTaskElapsed(task)}` : agentStatusText(task.status);
    row.append(dot, copy, state);
    row.addEventListener("click", () => openAgentTaskFromHub(task));
    el.agentTaskList.appendChild(row);
  }
}

function agentTaskCenterFilterMatches(task, filter) {
  const status = String(task?.status || "");
  if (filter === "active") return agentTaskIsRunning(task) || status === "waiting";
  if (filter === "all" || !filter) return true;
  return status === filter;
}

function agentTaskCenterSort(a, b) {
  const activeOrder = Number(agentTaskIsRunning(b)) - Number(agentTaskIsRunning(a));
  return activeOrder || (Number(b.lastActivityAt || b.startedAt) || 0) - (Number(a.lastActivityAt || a.startedAt) || 0);
}

function agentTaskCenterRows() {
  const query = String(el.agentTaskCenterSearch?.value || "").trim().toLocaleLowerCase();
  const filter = String(el.agentTaskCenterFilter?.value || "all");
  return [...agentTasks]
    .filter((task) => agentTaskCenterFilterMatches(task, filter))
    .filter((task) => {
      if (!query) return true;
      return [task.name, task.agentId, task.agent, task.cwd, task.worktree?.branch]
        .filter(Boolean).some((value) => String(value).toLocaleLowerCase().includes(query));
    })
    .sort(agentTaskCenterSort);
}

function renderAgentTaskCenter() {
  if (!el.agentTaskCenterList) return;
  const rows = agentTaskCenterRows();
  const total = agentTasks.length;
  if (el.agentTaskCenterSummary) {
    el.agentTaskCenterSummary.textContent = agentHubText("taskCenterCount", { visible: rows.length, total });
  }
  el.agentTaskCenterList.replaceChildren();
  el.agentTaskCenterEmpty?.classList.toggle("hidden", rows.length > 0);
  for (const task of rows) {
    const id = String(task.id || task.taskId || "");
    const status = String(task.status || "waiting").replace(/[^a-z0-9_-]/gi, "");
    const row = document.createElement("article");
    row.className = `agent-task-center-row ${agentTaskIsRunning(task) ? "running" : ""} ${status}`.trim();
    row.dataset.taskId = id;
    row.setAttribute("role", "listitem");

    const dot = document.createElement("span");
    dot.className = "agent-task-dot";
    dot.setAttribute("aria-hidden", "true");

    const open = document.createElement("button");
    open.type = "button";
    open.className = "agent-task-center-open";
    open.addEventListener("click", () => {
      closeAgentTaskCenter();
      openAgentTaskFromHub(task);
    });
    const copy = document.createElement("span");
    copy.className = "agent-task-center-copy";
    const name = document.createElement("strong");
    name.textContent = task.agentId === "pi" ? sessionDisplayTitle(task) : task.name || agentConnectorLabel(task.agentId);
    name.dataset.i18nIgnore = "";
    const meta = document.createElement("span");
    meta.className = "agent-task-center-meta";
    const elapsed = agentTaskElapsed(task);
    meta.textContent = `${agentConnectorLabel(task.agentId)} · ${agentStatusText(task.status)}${elapsed ? ` · ${elapsed}` : ""}`;
    meta.dataset.i18nIgnore = "";
    const pathLabel = document.createElement("small");
    pathLabel.className = "agent-task-center-path";
    pathLabel.textContent = task.cwd || task.worktree?.path || agentHubText("taskNoOutput");
    pathLabel.dataset.i18nIgnore = "";
    const preview = document.createElement("small");
    preview.className = "agent-task-center-preview";
    const outputLine = stripAnsi(String(task.outputTail || "")).trim().split(/\r?\n/).filter(Boolean).pop();
    preview.textContent = outputLine || agentHubText("taskNoOutput");
    if (outputLine) preview.dataset.i18nIgnore = "";
    copy.append(name, meta, pathLabel, preview);
    open.appendChild(copy);

    const actions = document.createElement("span");
    actions.className = "agent-task-center-actions";
    const activity = document.createElement("small");
    activity.className = "agent-task-center-activity";
    activity.dataset.role = "activity";
    activity.textContent = task.lastActivityAt ? agentHubText("taskLastActivity", { value: fmtTime(task.lastActivityAt) }) : "";
    actions.appendChild(activity);
    if (agentTaskIsRunning(task) || task.status === "waiting") {
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "agent-task-center-stop btn ghost";
      stop.textContent = agentHubText("taskStop");
      stop.addEventListener("click", (event) => {
        event.stopPropagation();
        void stopAgentTaskFromCenter(task, stop);
      });
      actions.appendChild(stop);
    }
    row.append(dot, open, actions);
    el.agentTaskCenterList.appendChild(row);
  }
}

function updateAgentTaskCenterClock() {
  if (!el.agentTaskCenterList || el.agentTaskCenter?.classList.contains("hidden")) return;
  const byId = new Map(agentTasks.map((task) => [String(task.id || task.taskId || ""), task]));
  for (const row of el.agentTaskCenterList.querySelectorAll(".agent-task-center-row")) {
    const task = byId.get(String(row.dataset.taskId || ""));
    if (!task) continue;
    const meta = row.querySelector(".agent-task-center-meta");
    if (meta) {
      const elapsed = agentTaskElapsed(task);
      meta.textContent = `${agentConnectorLabel(task.agentId)} · ${agentStatusText(task.status)}${elapsed ? ` · ${elapsed}` : ""}`;
    }
  }
}

async function stopAgentTaskFromCenter(task, button) {
  const id = String(task?.id || task?.taskId || "");
  if (!id || !button) return;
  button.disabled = true;
  button.textContent = agentHubText("taskStopping");
  try {
    await post("/api/agent/abort", { taskId: id });
    toast(agentHubText("taskStoppedToast"));
    await refreshAgentTasks();
  } catch (error) {
    toast(error.message || agentHubText("taskStopFailed"), true);
    button.disabled = false;
    button.textContent = agentHubText("taskStop");
  }
}

function openAgentTaskCenter() {
  if (!el.agentTaskCenter) return;
  renderAgentTaskCenter();
  el.agentTaskCenter.classList.remove("hidden");
  el.agentTaskCenterSearch?.focus({ preventScroll: true });
  void refreshAgentTasks();
}

function closeAgentTaskCenter() {
  el.agentTaskCenter?.classList.add("hidden");
}

// The task list is polled for truth, but elapsed labels should feel like a
// local clock. Update only the state text so a focused row, scroll position,
// and any active pointer gesture are never disturbed by a full re-render.
function updateAgentHubClock() {
  if (!el.agentTaskList) return;
  const byId = new Map(agentTasks.map((task) => [String(task.id || task.taskId || ""), task]));
  for (const row of el.agentTaskList.querySelectorAll(".agent-task-row")) {
    const task = byId.get(String(row.dataset.taskId || ""));
    const state = row.querySelector(".agent-task-state");
    if (!task || !state) continue;
    const elapsed = agentTaskElapsed(task);
    state.textContent = elapsed ? `${agentStatusText(task.status)} · ${elapsed}` : agentStatusText(task.status);
  }
  updateAgentTaskCenterClock();
}

function renderNewAgentOptions() {
  if (!el.newAgent) return;
  const previous = el.newAgent.value || "pi";
  el.newAgent.replaceChildren();
  const connectors = agentCatalog;
  for (const connector of connectors) {
    const option = document.createElement("option");
    option.value = connector.id;
    option.textContent = connector.installed ? connector.label : `${connector.label} · ${agentHubText("notInstalled")}`;
    option.disabled = connector.installed !== true;
    option.dataset.i18nIgnore = "";
    el.newAgent.appendChild(option);
  }
  const selected = [...el.newAgent.options].find((option) => option.value === previous && !option.disabled)
    || [...el.newAgent.options].find((option) => option.value === "pi" && !option.disabled)
    || [...el.newAgent.options].find((option) => !option.disabled);
  if (selected) el.newAgent.value = selected.value;
  updateNewAgentNote();
}

function updateNewAgentNote() {
  const id = el.newAgent?.value;
  const connector = agentCatalog.find((item) => item.id === id);
  const unavailable = agentCatalogError || connector?.installed !== true;
  if (el.newStart) el.newStart.disabled = unavailable;
  if (el.newAgentNote) el.newAgentNote.textContent = unavailable ? agentHubText(agentCatalogError ? "unavailable" : "discovering") : id === "pi" ? agentHubText("piNote") : (connector?.description || agentHubText("cliNote"));
  if (el.newWorktree) el.newWorktree.disabled = connector?.capabilities?.includes("worktree") === false;
}

async function loadAgentCatalog() {
  if (agentCatalogRequest) agentCatalogRequest.abort();
  const request = new AbortController();
  agentCatalogRequest = request;
  const base = apiBase, host = selectedId;
  const isCurrent = () => agentCatalogRequest === request && !request.signal.aborted && base === apiBase && host === selectedId;
  try {
    const data = await api("/api/agents", { signal: request.signal });
    if (!isCurrent()) return;
    if (!Array.isArray(data?.connectors)) throw new Error("Invalid agent catalog");
    agentCatalog = data.connectors;
    agentCatalogError = false;
    renderNewAgentOptions();
    renderAgentHub();
  } catch (error) {
    if (isCurrent() && error?.name !== "AbortError") {
      // Only a legacy Host without this endpoint can use the Pi-only catalog.
      // Network/auth errors are unknown, not proof that Pi is installed.
      agentCatalogError = error?.status !== 404;
      if (!agentCatalogError) agentCatalog = [{ id: "pi", label: "Pi Agent", installed: true, kind: "native", capabilities: ["rpc", "worktree"] }];
      renderNewAgentOptions();
      renderAgentHub();
    }
  } finally {
    if (agentCatalogRequest === request) agentCatalogRequest = null;
  }
}

let agentTaskRefreshRequest = null;
function resetAgentHub() {
  agentCatalogRequest?.abort();
  agentTaskRefreshRequest?.abort();
  agentCatalogRequest = agentTaskRefreshRequest = null;
  agentCatalog = [];
  agentTasks = [];
  agentCatalogError = false;
  renderNewAgentOptions();
  renderAgentHub();
  renderAgentTaskCenter();
  syncAgentTaskPolling();
}

async function refreshAgentTasks() {
  if (agentTaskRefreshRequest) agentTaskRefreshRequest.abort();
  const request = new AbortController();
  agentTaskRefreshRequest = request;
  const base = apiBase, host = selectedId;
  const isCurrent = () => agentTaskRefreshRequest === request && !request.signal.aborted && base === apiBase && host === selectedId;
  try {
    const data = await api("/api/agent-tasks", { signal: request.signal });
    if (!isCurrent()) return;
    if (!Array.isArray(data?.tasks)) throw new Error("Invalid task snapshot");
    agentTasks = data.tasks;
    renderAgentHub();
    renderAgentTaskCenter();
    syncAgentTaskPolling();
    // Restore only after a successful task snapshot; doing this before the
    // first fetch would race the durable generic-task list and fall back to a
    // stale native session.
    void restoreLastChat();
  } catch (error) {
    if (isCurrent() && error?.name !== "AbortError") {
      // Keep the last truthful snapshot during a transient network hiccup.
      // Clearing it makes a long-running task disappear even though its
      // supervisor is still alive and the next poll can recover it.
      renderAgentHub();
      renderAgentTaskCenter();
    }
  } finally {
    if (agentTaskRefreshRequest === request) agentTaskRefreshRequest = null;
  }
}

function syncAgentTaskPolling() {
  const listVisible = el.viewList && !el.viewList.classList.contains("hidden");
  const hasRunning = agentTasks.some(agentTaskIsRunning);
  if (listVisible && hasRunning) {
    if (!agentTaskPollTimer) agentTaskPollTimer = setInterval(() => void refreshAgentTasks(), 5000);
    if (!agentHubTicker) agentHubTicker = setInterval(updateAgentHubClock, 1000);
    return;
  }
  if (agentTaskPollTimer) {
    clearInterval(agentTaskPollTimer);
    agentTaskPollTimer = null;
  }
  if (agentHubTicker) {
    clearInterval(agentHubTicker);
    agentHubTicker = null;
  }
}

async function openAgentTaskFromHub(task) {
  if (!task) return;
  if (task.agentId === "pi" && (task.file || task.sessionFile)) {
    const file = task.file || task.sessionFile;
    return openExisting(sessionsCache.find(session => session.file === file) ||
      { file, cwd: task.cwd || "", name: task.sessionName || null, firstMessage: task.firstMessage });
  }
  return openGenericTask(task);
}

el.agentHubRefresh?.addEventListener("click", () => { void loadAgentCatalog(); void refreshAgentTasks(); });
el.agentHubOpenCenter?.addEventListener("click", openAgentTaskCenter);

function renderClaudeAuth({ data, error, pending }) {
  const status = $("claude-auth-status"), start = $("claude-auth-start"), cancel = $("claude-auth-cancel"), refresh = $("claude-auth-refresh");
  if (!status || !start || !cancel || !refresh) return;
  const key = error || data?.blockedReason || (data?.login ? `login_${data.login.state}` : data?.credential?.state) || "unchecked";
  status.dataset.i18nKey = `claudeAuth.${key}`;
  status.textContent = tKey(`claudeAuth.${key}`);
  $("claude-auth-note").textContent = tKey("claudeAuth.note", { machine: machineName(selectedId) });
  start.disabled = pending || !!error || data?.canStart !== true;
  refresh.disabled = pending;
  const active = ["prepared", "starting", "waiting", "verifying", "cancelling"].includes(data?.login?.state);
  // A previous completed/cancelled attempt must not hide a later sign-out.
  const credential = $("claude-auth-credential");
  credential.classList.toggle("hidden", !data?.login || active);
  credential.dataset.i18nKey = `claudeAuth.${data?.credential?.state || "unchecked"}`;
  credential.textContent = tKey(credential.dataset.i18nKey);
  cancel.classList.toggle("hidden", !active);
  cancel.disabled = pending || data?.login?.state === "cancelling";
}
claudeAuthClient = window.stepsembleClaudeAuth?.createController({ request: api, render: renderClaudeAuth,
  scope: () => apiBase, isVisible: () => !!$("claude-auth")?.open && !document.hidden });
$("claude-auth")?.addEventListener("toggle", () => {
  if ($("claude-auth").open) void claudeAuthClient?.refresh(); else claudeAuthClient?.pause();
});
$("claude-auth-refresh")?.addEventListener("click", () => void claudeAuthClient?.refresh());
$("claude-auth-start")?.addEventListener("click", () => {
  if (window.confirm(tKey("claudeAuth.confirm", { machine: machineName(selectedId) }))) void claudeAuthClient?.start();
});
$("claude-auth-cancel")?.addEventListener("click", () => void claudeAuthClient?.cancel());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) claudeAuthClient?.pause();
  else if ($("claude-auth")?.open) void claudeAuthClient?.refresh();
});
el.agentTaskCenterClose?.addEventListener("click", closeAgentTaskCenter);
el.agentTaskCenter?.addEventListener("click", (event) => { if (event.target === el.agentTaskCenter) closeAgentTaskCenter(); });
el.agentTaskCenterSearch?.addEventListener("input", renderAgentTaskCenter);
el.agentTaskCenterFilter?.addEventListener("change", renderAgentTaskCenter);
el.newAgent?.addEventListener("change", updateNewAgentNote);

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
    const currentSummary = sessionsCache.find(session => session.file === currentSessionFile);
    if (currentSummary && !el.viewChat.classList.contains("hidden")) setChatTitle(sessionDisplayTitle(currentSummary));
    temporarySessionCount = Math.max(0, Number(data.temporarySessionCount) || 0);
    if (el.sessionCount) el.sessionCount.textContent = String(sessionsCache.length);
    renderTemporarySessionFilter(temporarySessionCount);
    renderSessionList(el.search.value);
    syncSessionListPolling();
    void refreshStuckSessions();
    void refreshAgentTasks();
  } catch (e) {
    if (e.name !== "AbortError") { /* unauthorized 已處理 */ }
  } finally {
    if (sequence === refreshSequence) refreshRequest = null;
  }
}

// The session list used to lag behind the chat: a brand-new session only
// appeared after a manual reload because nothing re-fetched the list once pi
// wrote the file. Runs and user messages are the natural boundaries, so
// schedule a coalesced refresh on both (sub agent sessions also surface when
// the parent run settles).
let sessionListRefreshTimer = null;
function scheduleSessionListRefresh(delayMs = 1200) {
  if (sessionListRefreshTimer) clearTimeout(sessionListRefreshTimer);
  sessionListRefreshTimer = setTimeout(() => {
    sessionListRefreshTimer = null;
    void refreshSessions();
  }, delayMs);
}

// While a run is active, refresh the list periodically so its state stays
// truthful after a reload: a finished run drops its badge on its own. The
// poll only exists while the list is visible and something is running, so an
// idle app makes no extra requests.
let sessionListPollTimer = null;

// While a run is active this polls the cheap /api/rpcs endpoint and only
// redraws the list when the visible set actually changes (a run started or
// settled, or its stuck flag flipped). Elapsed-time text stays fresh via the
// 1s ticker without touching DOM structure, so a full innerHTML rebuild every
// five seconds — with its scroll and focus churn — never happens.
let lastRunningSignature = "";
async function refreshRunningState() {
  if (el.viewList.classList.contains("hidden")) { syncSessionListPolling(); return; }
  try {
    const data = await api("/api/rpcs");
    const live = new Map();
    for (const rpc of (Array.isArray(data?.rpcs) ? data.rpcs : [])) {
      if (rpc.exited || !rpc.isStreaming) continue;
      const file = rpc.file || rpc.sessionFile;
      if (file) live.set(file, rpc);
    }
    let changed = false;
    for (const session of sessionsCache) {
      const was = !!session.isRunning;
      const entry = live.get(session.file) || null;
      const now = !!entry;
      session.isRunning = now;
      session.runStartedAt = entry?.runStartedAt || (now ? session.runStartedAt : null);
      const stuck = now ? !!entry.stuck : false;
      if (was !== now || session.runStuck !== stuck) changed = true;
      session.runStuck = stuck;
    }
    const signature = sessionsCache
      .filter((session) => session.isRunning)
      .map((session) => session.file + ":" + (session.runStuck ? "s" : "r"))
      .sort()
      .join("|");
    if (signature !== lastRunningSignature) changed = true;
    lastRunningSignature = signature;
    if (changed) renderSessionList(el.search.value);
  } catch { /* transient network errors: the next tick retries */ }
}
function syncSessionListPolling() {
  const listVisible = el.viewList && !el.viewList.classList.contains("hidden");
  const hasRunning = sessionsCache.some((session) => session.isRunning);
  if (listVisible && hasRunning) {
    if (!sessionListPollTimer) sessionListPollTimer = setInterval(() => void refreshRunningState(), 5000);
    return;
  }
  if (sessionListPollTimer) {
    clearInterval(sessionListPollTimer);
    sessionListPollTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Reopen the conversation the user had open before a reload
// ---------------------------------------------------------------------------

const LAST_CHAT_KEY = "stepsemble.last-chat.v1";
const LAST_AGENT_TASK_KEY = "stepsemble.last-agent-task.v1";
const LEGACY_LAST_CHAT_KEYS = Object.freeze(["piharbor.last-chat.v1", "piweb.last-chat.v1"]);
const LEGACY_LAST_AGENT_TASK_KEYS = Object.freeze(["piharbor.last-agent-task.v1", "piweb.last-agent-task.v1"]);
let lastChatRestoreAttempted = false;

function lastChatMachineKey() {
  return selectedId || selfId || "local";
}

function rememberLastChat(file) {
  if (!file) return;
  try {
    const raw = JSON.parse(migratedStorageValue(localStorage, LAST_CHAT_KEY, LEGACY_LAST_CHAT_KEYS) || "{}");
    raw[lastChatMachineKey()] = String(file);
    localStorage.setItem(LAST_CHAT_KEY, JSON.stringify(raw));
  } catch {}
}

function readLastChat() {
  try {
    const raw = JSON.parse(migratedStorageValue(localStorage, LAST_CHAT_KEY, LEGACY_LAST_CHAT_KEYS) || "{}");
    const file = raw[lastChatMachineKey()];
    return typeof file === "string" && file ? file : null;
  } catch { return null; }
}

function rememberLastAgentTask(taskId) {
  const id = String(taskId || "").trim();
  if (!id || id.startsWith("pi:")) return;
  try {
    const raw = JSON.parse(migratedStorageValue(localStorage, LAST_AGENT_TASK_KEY, LEGACY_LAST_AGENT_TASK_KEYS) || "{}");
    raw[lastChatMachineKey()] = id;
    localStorage.setItem(LAST_AGENT_TASK_KEY, JSON.stringify(raw));
  } catch {}
}

function clearLastAgentTask() {
  try {
    const raw = JSON.parse(migratedStorageValue(localStorage, LAST_AGENT_TASK_KEY, LEGACY_LAST_AGENT_TASK_KEYS) || "{}");
    delete raw[lastChatMachineKey()];
    localStorage.setItem(LAST_AGENT_TASK_KEY, JSON.stringify(raw));
  } catch {}
}

function readLastAgentTask() {
  try {
    const raw = JSON.parse(migratedStorageValue(localStorage, LAST_AGENT_TASK_KEY, LEGACY_LAST_AGENT_TASK_KEYS) || "{}");
    const id = raw[lastChatMachineKey()];
    return typeof id === "string" && id && !id.startsWith("pi:") ? id : null;
  } catch { return null; }
}

async function restoreLastChat() {
  if (lastChatRestoreAttempted) return;
  lastChatRestoreAttempted = true;
  const taskId = readLastAgentTask();
  if (taskId) {
    const task = agentTasks.find((item) => String(item.id || item.taskId || "") === taskId);
    if (task) {
      // The Agent Hub list is durable, so a browser reload can return to a
      // generic task even when its HTTP/SSE connection was gone in between.
      await openAgentTaskFromHub(task);
      return;
    }
    clearLastAgentTask();
  }
  const file = readLastChat();
  if (!file || currentSessionFile === file) return;
  // The setup guide must not end up underneath an opened chat.
  if (el.onboarding && !el.onboarding.classList.contains("hidden")) return;
  const session = sessionsCache.find((s) => s.file === file);
  if (!session) return;
  await openExisting(session);
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
    // A short constant label keeps the row readable in every locale, even in
    // the narrowest desktop sidebar; the toggle and note carry the state.
    el.temporarySessionFilterLabel.textContent = window.stepsembleI18n?.t("Sub Agent sessions") || "Sub Agent sessions";
  }
  const note = el.temporarySessionFilterNote;
  if (note) {
    note.textContent = window.stepsembleI18n?.t(settings.showTemporarySessions ? "Showing" : "Hidden by default")
      || (settings.showTemporarySessions ? "Showing" : "Hidden by default");
  }
  if (el.temporarySessionCount) {
    el.temporarySessionCount.textContent = String(total);
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

function updateNewProjectAffordance() {
  const hasSessions = sessionsCache.length > 0;
  el.viewList?.classList.toggle("has-sessions", hasSessions);
  const newProjectLabel = window.stepsembleI18n?.t("New project") || "New project";
  if (el.btnNewProject) {
    el.btnNewProject.classList.toggle("hidden", hasSessions);
    el.btnNewProject.setAttribute("aria-label", newProjectLabel);
  }
  if (el.btnNew) {
    el.btnNew.classList.toggle("hidden", !hasSessions);
    el.btnNew.title = newProjectLabel;
    el.btnNew.setAttribute("aria-label", newProjectLabel);
  }
  // These mutually exclusive states keep the list focused: one large empty
  // state action or one compact top-bar action once content exists.
}

// A running session shows how long it has been working, so reopening the app
// mid-run answers "is it still going?" without opening the conversation.
let sessionRunTicker = null;

function renderSessionRunMeta(meta, usage) {
  const startedAt = Number(meta.dataset.runStartedAt) || 0;
  const stuck = meta.dataset.runStuck === "1";
  const elapsed = startedAt ? window.stepsembleSessionUtils.runElapsedText(Date.now() - startedAt) : "";
  const label = stuck
    ? tKey("sessions.runStuck")
    : (elapsed ? tKey("sessions.runningFor", { elapsed }) : tKey("sessions.running"));
  meta.textContent = usage ? label + " · " + usage : label;
  meta.classList.remove("hidden");
}

function updateSessionRunTicker() {
  const metas = el.sessionList?.querySelectorAll?.(".session-running-meta") || [];
  for (const meta of metas) renderSessionRunMeta(meta, meta.dataset.usage || "");
  if (!metas.length && sessionRunTicker) {
    clearInterval(sessionRunTicker);
    sessionRunTicker = null;
  }
}

function updateSessionSelection() {
  // Opening a chat changes selection, not the list's content/order. Keep the
  // existing rows, keyboard focus and scroll position instead of rebuilding
  // every visible row in the input event's critical path.
  for (const row of el.sessionList.querySelectorAll(".session-item")) {
    const selected = row.dataset.sessionFile === currentSessionFile;
    row.classList.toggle("selected", selected);
    const button = row.querySelector(".session-item-main");
    if (selected) button?.setAttribute("aria-current", "true");
    else button?.removeAttribute("aria-current");
  }
}

function renderSessionList(q) {
  updateNewProjectAffordance();
  const query = (q || "").trim().toLowerCase();
  const list = sessionsCache.filter(s => !query ||
    (s.name || "").toLowerCase().includes(query) ||
    (s.firstMessage || "").toLowerCase().includes(query) ||
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
    li.dataset.sessionFile = s.file;
    const rawName = sessionDisplayTitle(s);
    const name = stripMd(rawName).slice(0, 70) || (window.stepsembleI18n?.t("(Untitled)") || "(Untitled)");
    // Recency first: scanning for "what did I just do" beats tok/$.
    const relative = window.stepsembleSessionUtils.compactRelativeTime(s.mtimeMs);
    const when = relative || (s.mtimeMs ? tKey("sessions.justNow") : "");
    const usage = [
      when,
      s.tokens ? `${fmtTokens(s.tokens)} tok` : "",
      s.cost ? "$" + s.cost.toFixed(2) : "",
    ].filter(Boolean).join(" · ");
    li.innerHTML = `
      <button class="session-item-main" type="button">
        <span class="session-pin-indicator hidden" role="img"></span>
        <span class="session-item-copy">
          <span class="s-name"></span>
          <span class="s-meta"></span>
        </span>
      </button>
      <span class="session-item-actions"></span>`;
    li.querySelector(".s-name").textContent = name;
    const meta = li.querySelector(".s-meta");
    // A session that is still working outranks its token/cost summary: after
    // a reload this row is the only place that says the host is busy.
    if (s.isRunning) {
      li.classList.add("session-running");
      const dot = document.createElement("span");
      dot.className = "session-running-dot";
      dot.setAttribute("aria-hidden", "true");
      li.querySelector(".session-item-copy").prepend(dot);
      meta.classList.add("session-running-meta");
      meta.dataset.runStartedAt = s.runStartedAt ? String(s.runStartedAt) : "";
      meta.dataset.runStuck = s.runStuck ? "1" : "";
      meta.dataset.usage = usage;
      renderSessionRunMeta(meta, usage);
    } else {
      meta.textContent = usage;
      meta.classList.toggle("hidden", !usage);
    }
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
      try {
        const result = await post("/api/session-action", { action: "archive", file: s.file });
        const isCurrent = currentSessionFile === s.file && !el.viewChat.classList.contains("hidden");
        toast(projectActionText("Archived chats"), false, {
          label: tKey("common.undo"),
          run: async () => {
            try {
              await post("/api/session-action", { action: "unarchive", archiveId: result?.archiveId });
              toast(projectActionText("Restored"));
              refreshSessions();
            } catch (error) { toast(error.message || projectActionText("Could not archive chats"), true); }
          },
        });
        if (isCurrent) showList();
        else refreshSessions();
      } catch (error) {
        toast(error.message || projectActionText("Could not archive chats"), true);
      }
    });
    const sessionMain = li.querySelector(".session-item-main");
    if (s.file === currentSessionFile) sessionMain?.setAttribute("aria-current", "true");
    let lpTimer = null, longPressed = false, swipeConsumed = false, touchStartX = 0, touchStartY = 0;
    li.addEventListener("touchstart", (event) => {
      if (event.target.closest(".session-item-action")) return;
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
    sessionMain?.addEventListener("click", () => {
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
    sessionMain?.addEventListener("keydown", (event) => {
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
          ? (window.stepsembleI18n?.t("Show less") || "Show less")
          : `${window.stepsembleI18n?.t("Show more") || "Show more"} (${pinnedItems.length - PROJECT_SESSION_PREVIEW_LIMIT})`;
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
          ? (window.stepsembleI18n?.t("Show less") || "Show less")
          : `${window.stepsembleI18n?.t("Show more") || "Show more"} (${items.length - PROJECT_SESSION_PREVIEW_LIMIT})`;
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
        const newButton = projectIconButton("i-plus", window.stepsembleI18n?.t("New session in project") || "New session in project");
        newButton.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          openNewDialog(cwd);
        });
        const moreButton = projectIconButton("i-ellipsis", window.stepsembleI18n?.t("More project actions") || "More project actions");
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
      arrowButton.title = collapsed ? (window.stepsembleI18n?.t("Expand") || "Expand") : (window.stepsembleI18n?.t("Collapse") || "Collapse");
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
    more.textContent = `${window.stepsembleI18n?.t("Show more") || "Show more"} (${list.length - visibleList.length})`;
    more.setAttribute("aria-label", window.stepsembleI18n?.t("Show more sessions") || "Show more sessions");
    more.addEventListener("click", () => {
      sessionRenderLimit += 120;
      renderSessionList(el.search.value);
    });
    const moreWrap = document.createElement("li");
    moreWrap.className = "session-load-more-wrap";
    moreWrap.appendChild(more);
    el.sessionList.appendChild(moreWrap);
  }
  // Keep the elapsed time on running rows ticking while the list is open.
  if (el.sessionList?.querySelector?.(".session-running-meta")) {
    if (!sessionRunTicker) sessionRunTicker = setInterval(updateSessionRunTicker, 1000);
  } else if (sessionRunTicker) {
    clearInterval(sessionRunTicker);
    sessionRunTicker = null;
  }
  scheduleFullTextSearch(query);
}

// ---- 跨 session 全文搜尋：側欄搜尋框輸入 ≥2 字時，在列表下方追加
// 「全文結果」；伺服器端 bounded 掃描，前端 300ms debounce。
let fullTextSearchTimer = null;
let fullTextSearchQuery = "";
function scheduleFullTextSearch(query) {
  if (fullTextSearchTimer) clearTimeout(fullTextSearchTimer);
  fullTextSearchQuery = query;
  if (query.length < 2) return;
  fullTextSearchTimer = setTimeout(() => {
    fullTextSearchTimer = null;
    void runFullTextSearch(fullTextSearchQuery);
  }, 300);
}

async function runFullTextSearch(query) {
  if (query.length < 2 || query !== (el.search?.value || "").trim().toLowerCase()) return;
  const generation = viewGeneration;
  try {
    const data = await api("/api/session-search?q=" + encodeURIComponent(query));
    if (generation !== viewGeneration || query !== (el.search?.value || "").trim().toLowerCase()) return;
    const results = Array.isArray(data?.results) ? data.results : [];
    // 清掉上一輪的結果（用標記辨識，避免影響一般 session 項目）。
    el.sessionList.querySelectorAll(".session-fulltext-block").forEach((node) => node.remove());
    if (!results.length) return;
    const block = document.createElement("li");
    block.className = "session-fulltext-block";
    const heading = document.createElement("p");
    heading.className = "session-fulltext-heading";
    heading.textContent = window.stepsembleI18n?.t("Full-text results") || "Full-text results";
    block.appendChild(heading);
    for (const hit of results.slice(0, 10)) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "session-fulltext-row";
      const name = document.createElement("strong");
      name.textContent = sessionDisplayTitle(hit).slice(0, 70);
      const snippet = document.createElement("small");
      snippet.textContent = hit.snippet || "";
      row.append(name, snippet);
      row.addEventListener("click", () => openExisting(hit));
      block.appendChild(row);
    }
    el.sessionList.appendChild(block);
  } catch {}
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
  el.saTitle.textContent = sessionDisplayTitle(s).slice(0, 60);
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
el.saExport?.addEventListener("click", async () => {
  const s = actionTarget;
  closeSessionActions();
  if (!s?.file) return;
  try {
    const data = await api("/api/session-export?file=" + encodeURIComponent(s.file));
    const blob = new Blob([data.markdown || ""], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(data.name || "session").replace(/[\\/:*?"<>|]/g, "_")}.md`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(window.stepsembleI18n?.t("Session exported") || "Session exported");
  } catch (error) {
    toast(error.message || "Export failed", true);
  }
});
el.saDelete.addEventListener("click", async () => {
  const target = actionTarget;
  closeSessionActions();
  if (!target) return;
  const isCurrent = currentSessionFile === target.file && !el.viewChat.classList.contains("hidden");
  try {
    const result = await post("/api/delete", { file: target.file });
    toast(projectActionText("Archived chats"), false, result?.archiveId ? {
      label: tKey("common.undo"),
      run: async () => {
        try {
          await post("/api/session-action", { action: "unarchive", archiveId: result.archiveId });
          toast(projectActionText("Restored")); refreshSessions();
        } catch (error) { toast(error.message, true); }
      },
    } : undefined);
    if (isCurrent) showList();
    else refreshSessions();
  } catch (e) { toast(tKey("runtime.deleteFailed", { detail: e.message }), true); }
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
  } catch (e) { toast(tKey("runtime.renameFailed", { detail: e.message }), true); }
}

// ---- Project folder actions (Codex-style group menu) ----
let projectActionTarget = null;

function projectActionText(key) {
  return window.stepsembleI18n?.t(key) || key;
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
  if (!cwd) return;
  try {
    const result = await post("/api/project-action", { action: "archive", cwd });
    toast(projectActionText("Archived chats") + ": " + (result.count || 0), false, {
      label: tKey("common.undo"),
      run: async () => {
        try {
          await post("/api/session-action", { action: "unarchive", archiveId: result.archiveId });
          toast(projectActionText("Restored"));
          refreshSessions();
        } catch (error) { toast(error.message || projectActionText("Could not archive chats"), true); }
      },
    });
    refreshSessions();
  } catch (error) { toast(error.message || projectActionText("Could not archive chats"), true); }
});
el.projectActionRemove?.addEventListener("click", () => {
  const cwd = projectActionCwd();
  closeProjectActions();
  if (!cwd) return;
  const removed = new Set(settings.removedProjects || []);
  removed.add(cwd);
  saveProjectListSettings({ removedProjects: [...removed] });
  toast(projectActionText("Project removed"), false, {
    label: tKey("common.undo"),
    run: () => {
      const kept = new Set(settings.removedProjects || []);
      kept.delete(cwd);
      settings = saveSettings({ removedProjects: [...kept] });
      refreshSessions();
    },
  });
});

// ===========================================================================
// 對話視圖 + RPC
// ===========================================================================

function setChatTitle(title) {
  const value = String(title || "").trim();
  el.chatTitle.textContent = value || (window.stepsembleI18n?.t("New conversation") || "New conversation");
  el.chatTitle.toggleAttribute("data-i18n-ignore", !!value);
}

async function openExisting(s) {
  beginDraftScope({ file: s.file, cwd: s.cwd, name: s.name });
  const generation = ++viewGeneration;
  if (rpc) closeChat(!!(rpc.streaming || rpc.connectionLost));
  resetTaskProgress();
  resetProjectChanges();
  resetComposerSummary();
  currentSessionFile = s.file;
  currentSessionCwd = s.cwd;
  clearLastAgentTask();
  rememberLastChat(s.file);
  updateSessionSelection();
  hideChatEmpty();
  setChatTitle(sessionDisplayTitle(s));
  el.chatSub.dataset.base = s.cwd; el.chatSub.textContent = s.cwd; resetLiveUsage();
  removeHistoryLoadButton();
  historyState = { file: s.file, before: null, hasMore: false, loading: false };
  autoScrollPinned = true;
  el.messages.innerHTML = "";
  resetSessionUsage(s);
  ensureSessionUsageFooter();
  if (!isDesktop()) {
    el.viewList.classList.add("hidden"); syncSessionListPolling();
    el.viewChat.classList.remove("hidden");
  } else {
    el.viewChat.classList.remove("hidden");
  }

  try {
    const detail = await api("/api/session?file=" + encodeURIComponent(s.file) + "&limit=300");
    if (generation !== viewGeneration) return;
    currentSessionCwd = detail.cwd;
    // Detail is authoritative even when opening a stale Hub/search entry.
    setChatTitle(sessionDisplayTitle({ ...s, ...detail }));
    void refreshProjectChanges({ background: true });
    _lastMsgDate = null; lastUserText = "";
    // Build offscreen: yielding with partially mounted history would force
    // another full conversation layout/scroll on every slice.
    const staging = document.createElement("div");
    let sliceStarted = performance.now();
    for (const m of detail.messages || []) {
      if (performance.now() - sliceStarted > 8) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (generation !== viewGeneration) return;
        sliceStarted = performance.now();
      }
      maybeDateSeparator(m.ts || m.timestamp, staging);
      appendHistoryMessage(m, staging, { latest: true });
      if (m.role === "user") lastUserText = m.text || "";
    }
    mergeAdjacentWorkMessages(staging);
    const fragment = document.createDocumentFragment();
    while (staging.firstChild) fragment.appendChild(staging.firstChild);
    el.messages.appendChild(fragment);
    keepSessionUsageAtEnd();
    historyState.before = detail.nextBefore;
    historyState.hasMore = !!detail.hasMore;
    showHistoryLoadButton();
    scrollBottom(true);
  } catch (e) {
    console.warn("歷史讀取失敗", e);
    if (generation !== viewGeneration) return;
    if (e.status === 422) { toast(e.message, true); return; }
    void refreshProjectChanges({ background: true });
  }
  await connectRpc({ file: s.file }, generation);
}

let currentSessionCwd = null;
let historyState = null;
let historyLoadButton = null;

// ---------------------------------------------------------------------------
// Read-only Git changes inspector
// ---------------------------------------------------------------------------

const CHANGE_STATUS_LETTERS = Object.freeze({
  modified: "M", added: "A", deleted: "D", renamed: "R",
  copied: "C", untracked: "?", conflicted: "!",
});
const MAX_RENDERED_DIFF_LINES = 5000;

function changesText(key, vars = {}) {
  return tKey(`changes.${key}`, vars);
}

function projectChangesOpen() {
  return !!el.changesLayer && !el.changesLayer.classList.contains("hidden");
}

function changeKindText(kind) {
  return changesText(CHANGE_STATUS_LETTERS[kind] ? kind : "modified");
}

function renderProjectChangesChrome() {
  if (!el.btnChanges) return;
  const openLabel = changesText("open");
  const refreshLabel = changesText("refresh");
  const closeLabel = changesText("close");
  el.btnChanges.title = openLabel;
  el.btnChanges.setAttribute("aria-label", openLabel);
  el.changesTitle.textContent = changesText("title");
  const eyebrow = el.changesTitle.previousElementSibling;
  if (eyebrow) eyebrow.textContent = changesText("project");
  el.changesRefresh.title = refreshLabel;
  el.changesRefresh.setAttribute("aria-label", refreshLabel);
  el.changesClose.title = closeLabel;
  el.changesClose.setAttribute("aria-label", closeLabel);
  el.changesFilesPane.setAttribute("aria-label", changesText("changedFiles"));
  const backCopy = el.changesDetailBack?.querySelector("span");
  if (backCopy) backCopy.textContent = changesText("changedFiles");
}

function setChangesState(title, detail = "") {
  el.changesState.replaceChildren();
  const strong = document.createElement("strong");
  strong.textContent = title;
  el.changesState.appendChild(strong);
  if (detail) el.changesState.appendChild(document.createTextNode(detail));
  el.changesState.classList.remove("hidden");
}

function renderChangesSummary(data) {
  el.changesSummary.replaceChildren();
  if (!data?.repository) {
    el.changesSummary.classList.add("hidden");
    return;
  }
  const summary = data.summary || {};
  const items = [
    ["", changesText("fileCount", { count: Math.max(0, Number(summary.files) || 0) })],
    ["changes-additions", `+${Math.max(0, Number(summary.additions) || 0)}`],
    ["changes-deletions", `−${Math.max(0, Number(summary.deletions) || 0)}`],
  ];
  if (data.branch) items.unshift(["", changesText("branch", { branch: data.branch })]);
  for (const [className, copy] of items) {
    const span = document.createElement("span");
    if (className) span.className = className;
    span.textContent = copy;
    el.changesSummary.appendChild(span);
  }
  el.changesSummary.classList.remove("hidden");
}

function renderChangesBadge(data = projectChangesState?.data) {
  if (!el.changesBadge) return;
  const count = data?.repository ? Math.max(0, Number(data.summary?.files) || 0) : 0;
  el.changesBadge.textContent = count > 99 ? "99+" : String(count);
  el.changesBadge.classList.toggle("hidden", count === 0);
  const label = count ? changesText("openCount", { count }) : changesText("open");
  el.btnChanges?.setAttribute("aria-label", label);
}

function changePathParts(file) {
  const filePath = String(file?.path || "");
  const slash = filePath.lastIndexOf("/");
  const name = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  let context = slash >= 0 ? filePath.slice(0, slash) : "";
  if (file?.oldPath) context = `${file.oldPath} → ${context ? `${context}/` : ""}${name}`;
  if (file?.staged) context = context ? `${context} · ${changesText("staged")}` : changesText("staged");
  return { filePath, name, context };
}

function renderChangesList(files) {
  el.changesList.replaceChildren();
  const available = new Set(files.map((file) => file.path));
  if (selectedChangePath && !available.has(selectedChangePath)) selectedChangePath = "";
  for (const file of files) {
    const { filePath, name, context } = changePathParts(file);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "changes-file-row" + (filePath === selectedChangePath ? " selected" : "");
    button.dataset.path = filePath;
    button.setAttribute("aria-label", `${changeKindText(file.kind)}: ${filePath}`);
    button.title = filePath;

    const status = document.createElement("span");
    status.className = "changes-file-status";
    status.dataset.kind = file.kind;
    status.textContent = CHANGE_STATUS_LETTERS[file.kind] || "M";

    const copy = document.createElement("span");
    copy.className = "changes-file-copy";
    const strong = document.createElement("strong");
    strong.textContent = name;
    copy.appendChild(strong);
    if (context) {
      const small = document.createElement("small");
      small.textContent = context;
      copy.appendChild(small);
    }

    const numbers = document.createElement("span");
    numbers.className = "changes-file-numbers";
    if (Number.isFinite(file.additions) && file.additions > 0) {
      const add = document.createElement("span");
      add.className = "add";
      add.textContent = `+${file.additions}`;
      numbers.appendChild(add);
    }
    if (Number.isFinite(file.deletions) && file.deletions > 0) {
      const del = document.createElement("span");
      del.className = "del";
      del.textContent = `−${file.deletions}`;
      numbers.appendChild(del);
    }
    button.append(status, copy, numbers);
    button.addEventListener("click", () => void loadProjectDiff(filePath));
    el.changesList.appendChild(button);
  }
}

function resetRenderedDiff(message = changesText("selectFile")) {
  el.changesDiffKind.textContent = "";
  el.changesDiffTitle.textContent = "";
  el.changesDiff.replaceChildren();
  el.changesDiff.classList.add("hidden");
  el.changesDiffEmpty.textContent = message;
  el.changesDiffEmpty.classList.remove("hidden");
}

function renderProjectChanges() {
  if (!el.changesLayer) return;
  renderProjectChangesChrome();
  const state = projectChangesState;
  const data = state?.data || null;
  el.changesRepository.textContent = data?.root || currentSessionCwd || "";
  el.changesRefresh.disabled = state?.status === "loading" || state?.status === "refreshing";
  renderChangesSummary(data);
  renderChangesBadge(data);
  el.changesList.replaceChildren();

  if (!state || state.status === "loading") {
    setChangesState(changesText("loading"));
    resetRenderedDiff();
    return;
  }
  if (state.status === "error") {
    setChangesState(changesText("unavailable"), changesText("unavailableDetail"));
    resetRenderedDiff(changesText("unavailableDetail"));
    return;
  }
  if (!data?.repository) {
    setChangesState(changesText("notRepository"), changesText("notRepositoryDetail"));
    resetRenderedDiff(changesText("notRepositoryDetail"));
    return;
  }
  const files = Array.isArray(data.files) ? data.files : [];
  if (!files.length) {
    setChangesState(changesText("clean"), changesText("cleanDetail"));
    resetRenderedDiff();
    return;
  }
  el.changesState.classList.add("hidden");
  renderChangesList(files);
  if (projectChangesShouldResetScroll && projectChangesOpen()) {
    el.changesList.scrollTop = 0;
    // Run once more after layout so browser scroll anchoring cannot restore a
    // previous project's position when the new rows are inserted.
    requestAnimationFrame(() => {
      if (!selectedChangePath) el.changesList.scrollTop = 0;
      projectChangesShouldResetScroll = false;
    });
  }
  if (!selectedChangePath) resetRenderedDiff();
}

function diffLineClass(line) {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++") || line.startsWith("\\ No newline")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "";
}

function appendChangesNotice(copy) {
  const notice = document.createElement("div");
  notice.className = "changes-diff-notice";
  notice.textContent = copy;
  el.changesDiff.appendChild(notice);
}

function renderProjectDiff(data) {
  const file = data?.file || {};
  el.changesDiffKind.textContent = changeKindText(file.kind);
  el.changesDiffTitle.textContent = file.path || selectedChangePath;
  el.changesDiff.replaceChildren();
  el.changesDiffEmpty.classList.add("hidden");
  el.changesDiff.classList.remove("hidden");

  if (data?.binary) appendChangesNotice(changesText("binary"));
  if (data?.oversized) appendChangesNotice(changesText("oversized"));
  let renderedLines = 0;
  for (const item of data?.sections || []) {
    if (!item?.diff || renderedLines >= MAX_RENDERED_DIFF_LINES) continue;
    const section = document.createElement("section");
    section.className = "changes-diff-section";
    const label = document.createElement("div");
    label.className = "changes-diff-section-label";
    label.textContent = changesText(item.kind === "staged" ? "staged" : item.kind === "untracked" ? "untracked" : "worktree");
    const pre = document.createElement("pre");
    const lines = String(item.diff).split("\n");
    for (const line of lines.slice(0, MAX_RENDERED_DIFF_LINES - renderedLines)) {
      const span = document.createElement("span");
      const tone = diffLineClass(line);
      span.className = `changes-diff-line${tone ? ` ${tone}` : ""}`;
      span.textContent = line || " ";
      pre.appendChild(span);
      renderedLines += 1;
    }
    section.append(label, pre);
    el.changesDiff.appendChild(section);
  }
  if (!renderedLines && !data?.binary && !data?.oversized) appendChangesNotice(changesText("noDiff"));
  if (data?.truncated || renderedLines >= MAX_RENDERED_DIFF_LINES) appendChangesNotice(changesText("truncated"));
}

async function refreshProjectChanges({ background = false } = {}) {
  const cwd = currentSessionCwd;
  if (!cwd) return;
  if (projectChangesRequest) projectChangesRequest.controller.abort();
  const request = { controller: new AbortController(), cwd, generation: viewGeneration, base: apiBase };
  projectChangesRequest = request;
  const existing = projectChangesState?.cwd === cwd ? projectChangesState.data : null;
  projectChangesState = { status: background && existing ? "refreshing" : "loading", cwd, data: existing };
  renderProjectChanges();
  try {
    const data = await api(`/api/project-changes?cwd=${encodeURIComponent(cwd)}`, { signal: request.controller.signal });
    if (projectChangesRequest !== request || request.cwd !== currentSessionCwd || request.generation !== viewGeneration || request.base !== apiBase) return;
    projectChangesState = { status: "ready", cwd, data };
    renderProjectChanges();
    if (selectedChangePath && data.files?.some((file) => file.path === selectedChangePath) && projectChangesOpen()) {
      void loadProjectDiff(selectedChangePath);
    }
  } catch (error) {
    if (error?.name === "AbortError" || projectChangesRequest !== request) return;
    projectChangesState = { status: "error", cwd, data: null, error };
    renderProjectChanges();
  } finally {
    if (projectChangesRequest === request) projectChangesRequest = null;
  }
}

async function loadProjectDiff(filePath) {
  const cwd = currentSessionCwd;
  if (!cwd || !filePath) return;
  const pathChanged = selectedChangePath !== filePath;
  selectedChangePath = filePath;
  if (pathChanged && el.changesDiff) {
    el.changesDiff.scrollTop = 0;
    el.changesDiff.scrollLeft = 0;
  }
  el.changesLayer.classList.add("show-detail");
  renderChangesList(projectChangesState?.data?.files || []);
  el.changesDiffKind.textContent = "";
  el.changesDiffTitle.textContent = filePath;
  resetRenderedDiff(changesText("diffLoading"));
  el.changesDiffTitle.textContent = filePath;
  if (projectDiffRequest) projectDiffRequest.controller.abort();
  const request = { controller: new AbortController(), cwd, filePath, generation: viewGeneration, base: apiBase };
  projectDiffRequest = request;
  try {
    const data = await api(`/api/project-diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`, { signal: request.controller.signal });
    if (projectDiffRequest !== request || selectedChangePath !== filePath || request.cwd !== currentSessionCwd || request.generation !== viewGeneration || request.base !== apiBase) return;
    renderProjectDiff(data);
  } catch (error) {
    if (error?.name === "AbortError" || projectDiffRequest !== request) return;
    resetRenderedDiff(changesText("unavailableDetail"));
    el.changesDiffTitle.textContent = filePath;
    if (error?.status === 404) void refreshProjectChanges({ background: true });
  } finally {
    if (projectDiffRequest === request) projectDiffRequest = null;
  }
}

function openProjectChanges() {
  if (!currentSessionCwd || !el.changesLayer) return;
  el.changesLayer.classList.remove("hidden");
  el.changesLayer.classList.remove("show-detail");
  renderProjectChanges();
  void refreshProjectChanges({ background: true });
  requestAnimationFrame(() => el.changesClose?.focus());
}

function closeProjectChanges() {
  if (!el.changesLayer) return;
  el.changesLayer.classList.add("hidden");
  el.changesLayer.classList.remove("show-detail");
  if (projectDiffRequest) projectDiffRequest.controller.abort();
  projectDiffRequest = null;
}

function resetProjectChanges() {
  if (projectChangesRequest) projectChangesRequest.controller.abort();
  if (projectDiffRequest) projectDiffRequest.controller.abort();
  projectChangesRequest = null;
  projectDiffRequest = null;
  projectChangesState = null;
  selectedChangePath = "";
  projectChangesShouldResetScroll = true;
  if (el.changesList) el.changesList.scrollTop = 0;
  if (el.changesDiff) {
    el.changesDiff.scrollTop = 0;
    el.changesDiff.scrollLeft = 0;
  }
  closeProjectChanges();
  renderChangesBadge(null);
}

el.btnChanges?.addEventListener("click", openProjectChanges);
el.changesRefresh?.addEventListener("click", () => void refreshProjectChanges());
el.changesClose?.addEventListener("click", closeProjectChanges);
el.changesDetailBack?.addEventListener("click", () => el.changesLayer.classList.remove("show-detail"));
el.changesLayer?.addEventListener("click", (event) => {
  if (event.target === el.changesLayer) closeProjectChanges();
});

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
    let sliceStarted = performance.now();
    for (const message of detail.messages || []) {
      if (performance.now() - sliceStarted > 8) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (generation !== viewGeneration || historyState !== state) return;
        sliceStarted = performance.now();
      }
      appendHistoryMessage(message, staging);
    }
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
    toast(tKey("runtime.historyFailed", { detail: error.message }), true);
  } finally {
    if (historyState === state) state.loading = false;
  }
}

async function startNew(cwd, name, agentId = "pi", worktree = false) {
  beginDraftScope({ cwd, name });
  const generation = ++viewGeneration;
  if (rpc) closeChat(!!(rpc.streaming || rpc.connectionLost));
  resetTaskProgress();
  resetProjectChanges();
  resetComposerSummary();
  currentSessionFile = null;
  _lastMsgDate = null;
  updateSessionSelection();
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
    el.viewList.classList.add("hidden"); syncSessionListPolling();
    el.viewChat.classList.remove("hidden");
  } else {
    el.viewChat.classList.remove("hidden");
  }
  void refreshProjectChanges({ background: true });
  if (String(agentId || "pi") === "pi" && !worktree) {
    await connectRpc({ cwd, name }, generation);
  } else {
    await connectAgentTask({ agentId: String(agentId || "pi"), cwd, name, worktree: !!worktree }, generation);
  }
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
    const connection = rpc;
    const isCurrent = () => rpc === connection && generation === viewGeneration && baseAtStart === apiBase && !connection.streamEnded;
    // Reusing a live RPC hands back the run's real start time, so the timer
    // continues from the actual elapsed time rather than this page load.
    if (r.isStreaming) rpc.runStartedAt = Number(r.runStartedAt) || Date.now();
    setStreaming(!!r.isStreaming);
    let esFail = 0;

    const scheduleReconnect = (es, reason = "error") => {
      if (!isCurrent() || rpc.es !== es) return;
      if (rpc.readyTimer) clearTimeout(rpc.readyTimer);
      rpc.readyTimer = null;
      rpc.streamReady = false;
      try { es?.close(); } catch {}
      if (rpc.es === es) rpc.es = null;
      rpc.connectionLost = true;
      rpc.nativeUiSyncing = !!rpc.nativeUiSnapshots;
      refreshNativeDialogControls();
      const attempt = ++rpc.reconnectAttempt;
      const delay = Math.min(30_000, 800 * (2 ** Math.min(attempt - 1, 5)));
      el.queueNote.dataset.connection = "lost";
      el.queueNote.textContent = rpc.streaming
        ? tKey("runtime.streamRetry", { seconds: Math.ceil(delay / 1000) })
        : tKey("runtime.streamRecovering");
      el.queueNote.classList.remove("hidden");
      if (rpc.reconnectTimer) return;
      rpc.reconnectTimer = setTimeout(() => {
        if (!isCurrent()) return;
        rpc.reconnectTimer = null;
        openStream(Math.max(-1, Number(rpc.lastEventId) || -1));
      }, delay);
    };

    const openStream = (after) => {
      if (!isCurrent()) return;
      const es = new EventSource(baseAtStart + "/api/stream?sid=" + encodeURIComponent(sid) + "&after=" + encodeURIComponent(after) + "&uiSnapshot=1");
      const isCurrentStream = () => isCurrent() && rpc.es === es;
      rpc.es = es;
      rpc.streamReady = false;
      if (rpc.readyTimer) clearTimeout(rpc.readyTimer);
      rpc.readyTimer = setTimeout(() => {
        if (isCurrentStream() && !rpc.streamReady) {
          scheduleReconnect(es, "ready_timeout");
        }
      }, 12_000);
      const markStreamReady = (snapshot = null) => {
        if (!isCurrentStream()) return;
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
          else el.queueNote.textContent = tKey("runtime.streamRestored");
        }
      };
      es.onopen = () => {
        if (!isCurrentStream()) { try { es.close(); } catch {} return; }
        // onopen is the transport-level fallback for older Stepsemble peers;
        // current peers also send the named `connected` readiness handshake
        // below with a state snapshot.
        if (!rpc.nativeUiSnapshots) markStreamReady();
      };
      es.addEventListener("connected", (event) => {
        if (!isCurrentStream()) return;
        let snapshot = null;
        try { snapshot = JSON.parse(event.data); } catch {}
        if (!snapshot || snapshot.type !== "connected" || snapshot.sid !== sid) {
          scheduleReconnect(es, "invalid_connected"); return;
        }
        if (Object.hasOwn(snapshot, "nativeUiSnapshot")) {
          rpc.nativeUiSnapshots = true;
          rpc.nativeUiSyncing = true;
          if (!reconcileNativeDialogs(snapshot.nativeUiSnapshot, sid)) {
            scheduleReconnect(es, "invalid_ui_snapshot"); return;
          }
        } else rpc.nativeUiSnapshots = false; // Older Hosts retain additive replay.
        rpc.nativeUiSyncing = false;
        markStreamReady(snapshot);
        refreshNativeDialogControls();
      });
      es.onmessage = (event) => {
        if (!isCurrentStream()) { try { es.close(); } catch {} return; }
        esFail = 0;
        const eventId = Number(event.lastEventId);
        if (Number.isFinite(eventId)) rpc.lastEventId = Math.max(rpc.lastEventId, eventId);
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        handleRpcEvent(data, sid);
      };
      es.onerror = () => {
        if (!isCurrentStream()) { try { es.close(); } catch {} return; }
        if (rpc.streamEnded) return;
        esFail++;
        // EventSource does not expose the response status. Once a remote
        // stream has failed repeatedly, surface the same localized offline /
        // authorization state without ever hiding the gateway session.
        if (esFail >= 3 && baseAtStart) showRemoteAuthorizationState(baseAtStart);
        // Once full snapshots are negotiated, disable replies immediately and
        // reconnect under our bounded backoff; transport-open alone isn't ready.
        if (rpc.nativeUiSnapshots) { scheduleReconnect(es); return; }
        // EventSource will briefly retry by itself. After a few failures we
        // take over so the next request explicitly resumes after lastEventId.
        if (esFail < 3) return;
        scheduleReconnect(es);
      };
    };
    openStream(replayAfter);
  } catch (e) {
    if (generation !== viewGeneration) return;
    toast(tKey("runtime.openChatFailed", { detail: e.message }), true);
    showList();
    return;
  }
  void refreshCommands(rpc?.sid);
  void syncComposerState(rpc?.sid);
  // get_session_stats is the authoritative source for current context and
  // cumulative usage. It is intentionally fetched once on open, not polled.
  void syncSessionStats(rpc?.sid);
}

// ---------------------------------------------------------------------------
// Generic Agent Hub tasks
// ---------------------------------------------------------------------------

function agentConnectorLabel(agentId) {
  const id = String(agentId || "");
  if (id === "pi") return "Pi Agent";
  return agentCatalog.find((item) => item.id === id)?.label || id || "Agent";
}

function genericTaskTerminal(status) {
  return ["completed", "failed", "stopped", "orphaned", "detached"].includes(String(status || ""));
}

function updateAgentTaskCache(task) {
  if (!task) return;
  const id = String(task.id || task.taskId || "");
  if (!id || id.startsWith("pi:")) return;
  const normalized = { ...task, id, taskId: id };
  const index = agentTasks.findIndex((item) => String(item.id || item.taskId || "") === id);
  if (index < 0) agentTasks.unshift(normalized);
  else agentTasks[index] = { ...agentTasks[index], ...normalized };
  renderAgentHub();
  syncAgentTaskPolling();
}

function appendGenericOutput(text, stream = "stdout") {
  if (!rpc?.generic) return;
  const clean = stripAnsi(String(text ?? ""));
  if (!clean) return;
  if (!rpc.genericOutputNode || rpc.genericOutputNode.dataset.stream !== stream) {
    const shell = makeMsgShell("assistant", rpc.agentLabel || "Agent");
    const pre = document.createElement("pre");
    pre.className = `agent-terminal-output ${stream === "stderr" ? "stderr" : "stdout"}`;
    pre.dataset.stream = stream;
    shell.bubble.appendChild(pre);
    rpc.genericOutputNode = pre;
  }
  rpc.genericOutputNode.textContent += clean;
  scrollBottom();
}

function appendGenericTerminalNotice(status, event = {}) {
  if (!rpc?.generic || rpc.genericTerminalNotice) return;
  const terminal = String(status || "completed");
  rpc.genericTerminalNotice = terminal;
  const shell = makeMsgShell("assistant", rpc.agentLabel || "Agent");
  const box = document.createElement("div");
  box.className = terminal === "failed" ? "run-error" : "agent-terminal-status";
  const title = document.createElement("div");
  title.className = terminal === "failed" ? "run-error-title" : "agent-terminal-status-title";
  title.textContent = `${rpc.agentLabel || "Agent"} · ${agentStatusText(terminal)}`;
  box.appendChild(title);
  const details = [];
  if (event.error) details.push(String(event.error).slice(-4000));
  if (event.signal) details.push(agentHubText("signal", { value: event.signal }));
  if (event.code !== undefined && event.code !== null && Number(event.code) !== 0) details.push(agentHubText("exitCode", { value: event.code }));
  if (details.length) {
    const detail = document.createElement("div");
    detail.className = terminal === "failed" ? "run-error-message" : "agent-terminal-status-detail";
    detail.textContent = details.join(" · ");
    box.appendChild(detail);
  }
  shell.bubble.appendChild(box);
  scrollBottom();
}

function applyGenericTaskSnapshot(snapshot = {}) {
  if (!rpc?.generic) return;
  const status = String(snapshot.status || rpc.taskStatus || "running");
  rpc.taskStatus = status;
  if (snapshot.agentId) rpc.agentId = String(snapshot.agentId);
  if (snapshot.agentId) rpc.agentLabel = agentConnectorLabel(snapshot.agentId);
  if (Number.isFinite(Number(snapshot.startedAt)) && Number(snapshot.startedAt) > 0) rpc.runStartedAt = Number(snapshot.startedAt);
  if (Number.isFinite(Number(snapshot.endedAt)) && Number(snapshot.endedAt) > 0) rpc.runEndedAt = Number(snapshot.endedAt);
  rpc.activityLabel = status === "waiting" ? "waiting" : "working";
  updateAgentTaskCache({ ...snapshot, id: snapshot.id || snapshot.taskId || rpc.sid, agentId: rpc.agentId, name: rpc.name, cwd: rpc.cwd });
  setStreaming(agentTaskIsRunning({ status }));
  if (genericTaskTerminal(status)) appendGenericTerminalNotice(status, snapshot);
}

function handleAgentTaskEvent(ev, eventSid = rpc?.sid) {
  if (!rpc?.generic || (eventSid && rpc.sid !== eventSid)) return;
  markRpcActivity();
  if (!ev || typeof ev !== "object") return;
  if (ev.type === "connected") {
    applyGenericTaskSnapshot(ev);
    return;
  }
  if (ev.type === "task_started" || ev.type === "status") {
    applyGenericTaskSnapshot(ev);
    return;
  }
  if (ev.type === "output") {
    if (ev.replace === true) {
      el.messages.querySelectorAll(".agent-terminal-output").forEach(node => node.closest(".msg")?.remove());
      rpc.genericOutputNode = null;
    }
    appendGenericOutput(ev.text, ev.stream);
    return;
  }
  if (ev.type === "task_exit") {
    applyGenericTaskSnapshot({ ...ev, status: ev.status || rpc.taskStatus });
    if (genericTaskTerminal(ev.status || rpc.taskStatus)) rpc.streamEnded = true;
    setStreaming(false);
  }
}

async function openGenericTask(task) {
  if (!task) return;
  const cwd = task.cwd || task.worktree?.path || "";
  const name = task.name || agentConnectorLabel(task.agentId);
  rememberLastAgentTask(task.id || task.taskId);
  beginDraftScope({ cwd, name });
  const generation = ++viewGeneration;
  if (rpc) closeChat(!!(rpc.streaming || rpc.connectionLost));
  resetTaskProgress();
  resetProjectChanges();
  resetComposerSummary();
  currentSessionFile = null;
  currentAgentTaskId = String(task.id || task.taskId || "");
  _lastMsgDate = null;
  lastUserText = "";
  currentSessionCwd = cwd;
  historyState = null;
  removeHistoryLoadButton();
  autoScrollPinned = true;
  hideChatEmpty();
  setChatTitle(name);
  el.chatSub.dataset.base = cwd;
  el.chatSub.textContent = cwd;
  resetLiveUsage();
  el.messages.innerHTML = "";
  resetSessionUsage();
  ensureSessionUsageFooter();
  if (!isDesktop()) {
    el.viewList.classList.add("hidden");
    syncSessionListPolling();
    el.viewChat.classList.remove("hidden");
  } else {
    el.viewChat.classList.remove("hidden");
  }
  void refreshProjectChanges({ background: true });
  await connectAgentTask({ taskId: currentAgentTaskId }, generation);
}

async function connectAgentTask(options = {}, generation = viewGeneration) {
  const baseAtStart = apiBase;
  setStreaming(false);
  try {
    let result;
    if (options.taskId) {
      const detail = await api(`/api/agent-task?taskId=${encodeURIComponent(options.taskId)}`);
      result = detail?.task;
    } else {
      result = await post("/api/agent/open", {
        agentId: String(options.agentId || "pi"),
        cwd: options.cwd,
        name: options.name,
        worktree: !!options.worktree,
      });
    }
    if (generation !== viewGeneration || baseAtStart !== apiBase) return;
    const taskId = String(result?.id || result?.taskId || "");
    if (!taskId) throw new Error("Agent task did not return an id");
    const status = String(result.status || (result.isRunning ? "running" : "waiting"));
    rpc = {
      sid: taskId,
      generic: true,
      genericOutputNode: null,
      genericTerminalNotice: null,
      es: null,
      streaming: agentTaskIsRunning({ status }),
      connectionLost: false,
      streamEnded: false,
      streamReady: false,
      readyTimer: null,
      reconnectTimer: null,
      reconnectAttempt: 0,
      lastEventId: -1,
      lastActivityAt: Date.now(),
      lastEventAt: Date.now(),
      activityLabel: status === "waiting" ? "waiting" : "working",
      taskStatus: status,
      agentId: String(result.agentId || options.agentId || "agent"),
      agentLabel: agentConnectorLabel(result.agentId || options.agentId),
      name: result.name || options.name || "Agent task",
      cwd: result.cwd || options.cwd || currentSessionCwd || "",
      runStartedAt: Number(result.startedAt) || null,
      runEndedAt: Number(result.endedAt) || null,
    };
    currentAgentTaskId = taskId;
    updateAgentTaskCache({ ...result, id: taskId });
    setStreaming(rpc.streaming);
    let esFail = 0;

    const scheduleReconnect = (es) => {
      if (!rpc || rpc.sid !== taskId || rpc.streamEnded) return;
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
        ? tKey("runtime.streamRetry", { seconds: Math.ceil(delay / 1000) })
        : tKey("runtime.streamRecovering");
      el.queueNote.classList.remove("hidden");
      if (rpc.reconnectTimer) return;
      rpc.reconnectTimer = setTimeout(() => {
        if (!rpc || rpc.sid !== taskId || rpc.streamEnded) return;
        rpc.reconnectTimer = null;
        openStream(Math.max(-1, Number(rpc.lastEventId) || -1));
      }, delay);
    };

    const openStream = (after) => {
      if (!rpc || rpc.sid !== taskId || rpc.streamEnded) return;
      const es = new EventSource(baseAtStart + "/api/agent/stream?taskId=" + encodeURIComponent(taskId) + "&after=" + encodeURIComponent(after));
      rpc.es = es;
      rpc.streamReady = false;
      if (rpc.readyTimer) clearTimeout(rpc.readyTimer);
      rpc.readyTimer = setTimeout(() => {
        if (rpc?.sid === taskId && rpc.es === es && !rpc.streamReady && !rpc.streamEnded) scheduleReconnect(es);
      }, 12_000);
      const markStreamReady = (snapshot = null) => {
        if (!rpc || rpc.sid !== taskId || rpc.streamEnded) return;
        rpc.streamReady = true;
        if (rpc.readyTimer) clearTimeout(rpc.readyTimer);
        rpc.readyTimer = null;
        esFail = 0;
        rpc.connectionLost = false;
        rpc.reconnectAttempt = 0;
        rpc.lastEventAt = Date.now();
        applyGenericTaskSnapshot(snapshot || { status: rpc.taskStatus, id: taskId });
        if (genericTaskTerminal(rpc.taskStatus)) rpc.streamEnded = true;
        if (el.queueNote.dataset.connection === "lost") {
          delete el.queueNote.dataset.connection;
          if (!rpc.streaming) el.queueNote.classList.add("hidden");
          else el.queueNote.textContent = tKey("runtime.streamRestored");
        }
      };
      es.onopen = () => {
        if (rpc?.sid !== taskId) { try { es.close(); } catch {} return; }
        markStreamReady();
      };
      es.addEventListener("connected", (event) => {
        let snapshot = null;
        try { snapshot = JSON.parse(event.data); } catch {}
        if (Number.isSafeInteger(snapshot?.eventSeq) && snapshot.eventSeq < rpc.lastEventId) rpc.lastEventId = -1;
        markStreamReady(snapshot);
      });
      es.onmessage = (event) => {
        if (rpc?.sid !== taskId) { try { es.close(); } catch {} return; }
        const eventId = Number(event.lastEventId);
        if (Number.isFinite(eventId)) rpc.lastEventId = Math.max(rpc.lastEventId, eventId);
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        handleAgentTaskEvent(data, taskId);
      };
      es.onerror = () => {
        if (rpc?.sid !== taskId) { try { es.close(); } catch {} return; }
        if (rpc.streamEnded) return;
        esFail++;
        if (esFail >= 3 && baseAtStart) showRemoteAuthorizationState(baseAtStart);
        if (esFail >= 3) scheduleReconnect(es);
      };
    };
    openStream(-1);
  } catch (error) {
    if (generation !== viewGeneration) return;
    toast(tKey("runtime.openChatFailed", { detail: error.message }), true);
    showList();
  }
}

function closeChat(silent) {
  const awaitingNative = rpc && !rpc.generic && nativeDialogs.count(apiBase, rpc.sid) > 0;
  resetNativeDialogs();
  if (rpc) {
    const generic = !!rpc.generic;
    rpc.streamEnded = true;
    if (rpc.reconnectTimer) clearTimeout(rpc.reconnectTimer);
    if (rpc.readyTimer) clearTimeout(rpc.readyTimer);
    rpc.reconnectTimer = null;
    rpc.readyTimer = null;
    try { rpc.es && rpc.es.close(); } catch {}
    // Generic CLI tasks are supervised by the Agent Hub and intentionally keep
    // running when the user leaves the conversation. Native Pi keeps its
    // historical close-vs-preserve semantics.
    if (!generic && !silent && !awaitingNative) post("/api/close", { sid: rpc.sid }).catch(() => {});
    rpc = null;
  }
  currentAgentTaskId = null;
  // Leaving the conversation clears its timer; the next session starts fresh.
  if (runTimerInterval) { clearInterval(runTimerInterval); runTimerInterval = null; }
  if (el.runTimer) { el.runTimer.classList.add("hidden"); el.runTimer.textContent = ""; }
  delete el.queueNote.dataset.connection;
  pendingAssistant = null;
  liveToolCards = new Map();
  liveActivity = null;
  activeActivityRun = null;
  resetTaskProgress();
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
function addUsageToLocalTotal(target, raw) {
  const usage = normalizeWireUsage(raw);
  if (!usage) return;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
    const value = finiteNonNegative(usage[key]);
    if (value !== null) target[key] += value;
  }
  const total = usageTotalTokens(usage);
  if (total !== null) target.tokens += total;
  const cost = usageCostTotal(usage);
  if (cost !== null) target.cost += cost;
}

function resetSessionUsage(seed = null) {
  sessionUsage = { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const seedUsage = normalizeWireUsage(seed?.usage)
    || normalizeWireUsage({ tokens: seed?.tokens, cost: seed?.cost });
  addUsageToLocalTotal(sessionUsage, seedUsage);
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
    sessionUsageFooter.setAttribute("aria-label", "Conversation usage");
    el.messages.appendChild(sessionUsageFooter);
  }
  updateSessionUsageFooter();
  keepSessionUsageAtEnd();
  return sessionUsageFooter;
}
function addSessionUsage(u) {
  if (!u) return;
  addUsageToLocalTotal(sessionUsage, u);
  ensureSessionUsageFooter();
}

function resetContextDashboard() {
  contextStatsRequestSequence += 1;
  // The old Promise cannot be cancelled through the RPC relay; dropping its
  // handle plus the sequence guard prevents it from being coalesced with the
  // next session's request.
  contextStatsRequest = null;
  contextStats = null;
  contextStatsState = "awaiting";
  composerModelContextWindow = null;
  renderContextDashboard();
}

function markContextStatsAwaiting() {
  contextStatsState = "awaiting";
  if (contextStats?.contextUsage) {
    // Compaction invalidates only the current-context estimate. Keep the last
    // known cumulative totals and capacity visible until the authoritative
    // post-compaction stats response arrives.
    contextStats = {
      ...contextStats,
      contextUsage: { ...contextStats.contextUsage, tokens: null, percent: null },
    };
  }
  renderContextDashboard();
}

function contextDashboardIdentity() {
  return { sid: rpc?.sid || null, generation: viewGeneration, base: apiBase };
}

function contextStatsRequestIsCurrent(request) {
  return isContextRequestCurrent(request, contextDashboardIdentity())
    && request.sequence === contextStatsRequestSequence;
}

function renderContextDashboard() {
  if (!el.contextDashboard) return;
  const statsForValues = contextStatsState === "unavailable" ? null : contextStats;
  const usage = statsForValues?.tokens || {};
  const contextUsage = statsForValues?.contextUsage || null;
  const used = finiteNonNegative(contextUsage?.tokens);
  const capacity = contextStatsState === "unavailable"
    ? positiveFinite(composerModelContextWindow)
      ?? positiveFinite(contextStats?.contextCapacity)
    : positiveFinite(contextUsage?.contextWindow)
      ?? positiveFinite(contextStats?.contextCapacity)
      ?? positiveFinite(composerModelContextWindow);
  // Pi's contextUsage.percent is authoritative. Do not derive this from the
  // cumulative token totals: those totals survive compaction and count work
  // which is no longer in the current prompt context.
  const percent = finiteNonNegative(contextUsage?.percent);
  const cacheHitPercent = computeCacheHitRate(usage);
  // Most OpenAI-compatible providers never report cache writes (their caching
  // is automatic and surfaced only as cache hits). Show an em dash instead of
  // a bare 0 so an unsupported metric is not mistaken for real usage.
  const cacheWriteValue = finiteNonNegative(usage.cacheWrite);
  const cacheWriteDisplay = cacheWriteValue !== null && cacheWriteValue > 0
    ? formatTokenCount(cacheWriteValue)
    : "—";
  const setValue = (node, value) => { if (node) node.textContent = value; };
  setValue(el.contextUsed, formatTokenCount(used));
  setValue(el.contextCapacity, formatTokenCount(capacity));
  setValue(el.contextPercent, formatPercent(percent));
  setValue(el.contextInput, formatTokenCount(usage.input));
  setValue(el.contextOutput, formatTokenCount(usage.output));
  setValue(el.contextCacheHit, formatTokenCount(usage.cacheRead));
  setValue(el.contextCacheHitPercent, formatPercent(cacheHitPercent));
  setValue(el.contextCacheWrite, cacheWriteDisplay);
  if (el.contextCacheWrite) {
    el.contextCacheWrite.title = cacheWriteValue !== null && cacheWriteValue > 0
      ? "" : tKey("contextDashboard.cacheWriteNone");
  }

  const progressState = percent === null ? "unknown" : percent > 90 ? "critical" : percent > 70 ? "warning" : "normal";
  el.contextDashboard.dataset.contextState = progressState;
  if (el.contextProgress) {
    el.contextProgress.setAttribute("aria-valuetext", formatPercent(percent));
    if (percent === null) {
      el.contextProgress.style.setProperty("--context-ring-offset", CONTEXT_RING_CIRCUMFERENCE.toFixed(2));
      el.contextProgress.removeAttribute("aria-valuenow");
    } else {
      const progress = Math.min(100, Math.max(0, percent));
      el.contextProgress.style.setProperty("--context-ring-offset", (CONTEXT_RING_CIRCUMFERENCE * (1 - progress / 100)).toFixed(2));
      el.contextProgress.setAttribute("aria-valuenow", String(progress));
    }
  }

  const summary = tKey("contextDashboard.summary", {
    used: formatTokenCount(used), capacity: formatTokenCount(capacity), percent: formatPercent(percent),
    input: formatTokenCount(usage.input), output: formatTokenCount(usage.output),
    cacheHit: formatTokenCount(usage.cacheRead), cacheHitPercent: formatPercent(cacheHitPercent),
    cacheWrite: cacheWriteDisplay,
  });
  if (el.contextDashboardSummary) el.contextDashboardSummary.textContent = summary;
  const contextValue = el.contextDashboard.querySelector?.(".context-value-strong");
  if (contextValue) contextValue.setAttribute("aria-label", summary);
  if (el.contextDashboard) el.contextDashboard.setAttribute("aria-label", tKey("contextDashboard.context"));
  if (el.contextProgress) el.contextProgress.setAttribute("aria-label", tKey("contextDashboard.context"));
  if (el.contextDashboardStatus) {
    const status = contextStatsState === "unavailable"
      ? tKey("contextDashboard.unavailable")
      : (!contextStats || contextStatsState === "awaiting" || used === null || percent === null
        ? tKey("contextDashboard.awaiting") : "");
    el.contextDashboardStatus.textContent = status;
    el.contextDashboardStatus.classList.toggle("hidden", !status);
  }
}

/** Fetch exact current-context and cumulative session stats, without polling. */
function syncSessionStats(expectedSid = rpc?.sid) {
  if (!expectedSid || !rpc || rpc.sid !== expectedSid) return Promise.resolve(null);
  const identity = { sid: expectedSid, generation: viewGeneration, base: apiBase };
  const active = contextStatsRequest;
  if (active && isContextRequestCurrent(active, identity)) {
    // A response already in flight may predate the event that requested this
    // refresh. Coalesce it, then perform one follow-up after it settles.
    active.needsRefresh = true;
    return active.promise;
  }
  const request = {
    ...identity,
    sequence: ++contextStatsRequestSequence,
    needsRefresh: false,
    promise: null,
  };
  const promise = rpcCmd(expectedSid, { type: "get_session_stats" })
    .then((response) => {
      if (!contextStatsRequestIsCurrent(request)) return null;
      // A lifecycle event arrived while this response was in flight. Do not
      // paint a snapshot that predates that event; the coalesced follow-up
      // below will become the settled value.
      if (request.needsRefresh) return null;
      if (!response?.success) {
        contextStatsState = "unavailable";
        renderContextDashboard();
        return null;
      }
      const normalized = normalizeSessionStats(response.data, composerModelContextWindow);
      contextStats = normalized;
      contextStatsState = normalized.available ? "ready" : "unavailable";
      renderContextDashboard();
      return normalized;
    })
    .catch(() => {
      if (contextStatsRequestIsCurrent(request)) {
        contextStatsState = "unavailable";
        renderContextDashboard();
      }
      return null;
    });
  request.promise = promise;
  contextStatsRequest = request;
  promise.then(() => {
    if (contextStatsRequest !== request) return;
    contextStatsRequest = null;
    if (!request.needsRefresh || !contextStatsRequestIsCurrent(request)) return;
    request.needsRefresh = false;
    queueMicrotask(() => {
      if (contextStatsRequestIsCurrent(request)) void syncSessionStats(request.sid);
    });
  }, () => {
    if (contextStatsRequest === request) contextStatsRequest = null;
  });
  return promise;
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
  // Already-normalized items ({src, mimeType}) come straight back from the
  // gallery click handler; without this pass the second normalization saw no
  // `data` field and silently rejected every image, so the lightbox never
  // opened. Keep the function idempotent and still validate the URL below.
  if (!raw && typeof image?.src === "string") raw = image.src;
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

function makeThinking(text) {
  const box = document.createElement("div");
  box.className = "thinking-wrap";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "thinking-toggle";
  toggle.textContent = window.stepsembleI18n?.t("Thinking blocks") || "Thinking blocks";
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

function startActivityRun() {
  if (activeActivityRun && !activeActivityRun.settled) {
    // A single session-level run may contain retries or queued continuations.
    // Completion belongs to the final low-level run, not to an earlier reply
    // that happened before Pi continued automatically.
    activeActivityRun.finalResponse = false;
    activeActivityRun.outcome = null;
    activeActivityRun.failure = null;
    return activeActivityRun;
  }
  activeActivityRun = {
    activities: new Set(),
    tools: new Map(), // stable tool-call key -> {card, name, args, isError}
    toolSequence: 0,
    finalResponse: false,
    outcome: null,
    failure: null,
    settled: false,
  };
  return activeActivityRun;
}

function registerRunActivity(activity) {
  if (!activity || !activeActivityRun || activeActivityRun.settled) return;
  activeActivityRun.activities.add(activity);
}

function registerRunTool(card, toolCallId, name, args) {
  if (!card || !activeActivityRun || activeActivityRun.settled) return;
  const key = toolCallId ? `id:${toolCallId}` : (card.__receiptKey || `card:${++activeActivityRun.toolSequence}`);
  card.__receiptKey = key;
  const existing = activeActivityRun.tools.get(key);
  if (existing) {
    existing.card = card;
    existing.name = name || existing.name;
    if (args !== undefined) existing.args = args;
    return;
  }
  activeActivityRun.tools.set(key, { card, name, args, isError: false });
  const activity = card.closest(".activity-group")?.__activity;
  registerRunActivity(activity);
}

function updateRunToolError(card, isError) {
  if (!card || !activeActivityRun || activeActivityRun.settled) return;
  const record = activeActivityRun.tools.get(card.__receiptKey);
  if (record && isError) record.isError = true;
}

function noteRunFinalResponse(message) {
  if (!activeActivityRun || activeActivityRun.settled) return;
  if (!message || message.role !== "assistant" || message.toolCalls?.length) return;
  if (["error", "aborted", "length"].includes(message.stopReason)) return;
  if (String(message.text || "").trim()) activeActivityRun.finalResponse = true;
}

function setRunOutcome(outcome, failure = null) {
  if (!activeActivityRun || activeActivityRun.settled) return;
  // An agent_end with willRetry is intentionally not passed here. A terminal
  // outcome is only reliable once Pi has decided that no continuation will run.
  activeActivityRun.outcome = outcome;
  activeActivityRun.failure = failure || activeActivityRun.failure;
}

function runActivityGroups(run) {
  if (!run) return [];
  const groups = new Set(run.activities || []);
  for (const record of run.tools?.values?.() || []) {
    const card = record?.card;
    if (!card) continue;
    const activity = card.closest(".activity-group")?.__activity;
    if (activity) groups.add(activity);
  }
  return [...groups].filter((activity) => activityCards(activity).length);
}

function settleActivityRun(run, fallbackOutcome = "completed") {
  if (!run || run.settled) return null;
  const records = [...(run.tools?.values?.() || [])];
  const stats = activityReceiptStats(records.map((record) => {
    const card = record?.card;
    return { name: record?.name || card?.__tool?.name, args: record?.args ?? card?.__tool?.args, isError: record?.isError || card?.classList.contains("err") };
  }));
  const receipt = computeActivityReceipt({
    ...stats,
    finalResponse: !!run.finalResponse,
    outcome: run.outcome || fallbackOutcome,
  });
  if (receipt) {
    // One logical run gets one quiet receipt. In the uncommon case where DOM
    // grouping could not merge every activity row, place the aggregate on the
    // last row instead of repeating the same totals several times.
    const groups = runActivityGroups(run);
    for (const activity of groups) activity.receipt = null;
    const receiptActivity = groups[groups.length - 1];
    if (receiptActivity) {
      receiptActivity.receipt = receipt;
      updateActivityGroup(receiptActivity);
    }
  }
  run.settled = true;
  if (currentSessionCwd) void refreshProjectChanges({ background: true });
  return receipt;
}

function activityReceiptText(key, vars = {}) {
  const translated = window.stepsembleI18n?.t?.(key, vars);
  if (translated) return translated;
  return String(key).replace(/\{([a-zA-Z0-9_.-]+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`));
}

function formatActivityReceipt(receipt) {
  if (!receipt) return "";
  const statusKey = receipt.status === "failed" ? "Failed"
    : receipt.status === "interrupted" ? "Interrupted" : "Completed";
  const parts = [activityReceiptText(statusKey)];
  if (receipt.noFinalResponse) parts.push(activityReceiptText("No final response"));
  const files = Math.max(0, Number(receipt.editedFileCount) || 0);
  const tools = Math.max(0, Number(receipt.toolCount) || 0);
  parts.push(activityReceiptText(files === 1 ? "Edited {count} file" : "Edited {count} files", { count: files }));
  parts.push(activityReceiptText(tools === 1 ? "{count} tool" : "{count} tools", { count: tools }));
  return parts.join(" · ");
}

function refreshActivityReceipts() {
  for (const details of el.messages?.querySelectorAll?.(".activity-group") || []) {
    const activity = details.__activity;
    if (activity?.receipt) updateActivityGroup(activity);
  }
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
  // Work details are progressive disclosure: a run starts as one quiet row,
  // while the user can open it when they need the thinking or tool output.
  details.open = false;
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
    receipt: null,
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
    : (activity.receipt ? formatActivityReceipt(activity.receipt) : activitySummary(activity));
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
    registerRunActivity(liveActivity);
    updateActivityGroup(liveActivity, { running: running || liveActivity.running });
    return liveActivity;
  }
  if (liveActivity && (!bubble || liveActivity.details.parentElement === bubble)) {
    registerRunActivity(liveActivity);
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
  registerRunActivity(activity);
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
  updateRunToolError(card, !!isError);
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
  if (card) {
    registerRunTool(card, toolCallId, name, args);
    return card;
  }
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
  registerRunTool(card, toolCallId, name, args);
  if (toolCallId) liveToolCards.set(toolCallId, card);
  return card;
}
function summarizeArgs(args) {
  if (!args || typeof args !== "object") return "";
  return args.command || args.path || args.file_path || args.pattern || args.query ||
         Object.values(args).find(v => typeof v === "string")?.slice(0, 120) || "";
}
function appendHistoryMessage(m, container = el.messages, options = {}) {
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
    // Older-history pages are prepended after the latest plan has already
    // been rendered. Do not let an obsolete plan replace the current one;
    // still recover one when the first page did not contain any plan text.
    if (options.latest || container === el.messages || !taskProgress) updateTaskProgressFromAssistant(m.text, { running: false });
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
  const usage = normalizeWireUsage(u) || {};
  const total = usageTotalTokens(usage);
  const cost = usageCostTotal(usage);
  const d = document.createElement("div");
  d.className = "usage-tag";
  const parts = [];
  if (total !== null) parts.push(`${formatTokenCount(total)} tok`);
  if (cost !== null) parts.push(`$${Number(cost).toFixed(4)}`);
  d.textContent = parts.join(" · ");
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
    if (activeActivityRun?.activities?.has(sourceActivity) && targetActivity) {
      activeActivityRun.activities.add(targetActivity);
    }
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
    if (activeActivityRun?.activities?.has(sourceActivity)) {
      activeActivityRun.activities.add(targetActivity || sourceActivity);
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
  let target = container.firstElementChild;
  while (target) {
    const source = target.nextElementSibling;
    if (!source) break;
    if (target.classList.contains("msg") && source.classList.contains("msg") &&
        target.classList.contains("assistant") && source.classList.contains("assistant") &&
        mergeAssistantPair(target, source)) continue;
    target = source;
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

function dismissNativeDialog(request) {
  if (extensionUiRequest !== request) return;
  extensionUiRequest = null;
  el.extensionUiSheet.classList.add("hidden");
  el.extensionUiInput.value = "";
  el.extensionUiEditor.value = "";
  el.extensionUiInput.type = "text";
  el.extensionUiStatus.textContent = "";
}
function resetNativeDialogs() {
  nativeDialogs.clear();
  if (extensionUiRequest && !extensionUiRequest.kind) dismissNativeDialog(extensionUiRequest);
}
function suspendNativeDialog() {
  const request = extensionUiRequest;
  if (!request || request.kind) return;
  if (request.method === "input") request.draft = el.extensionUiInput.value;
  if (request.method === "editor") request.draft = el.extensionUiEditor.value;
  dismissNativeDialog(request);
}
function refreshNativeDialogControls() {
  const request = extensionUiRequest;
  if (!request || request.kind) return;
  const syncing = !!rpc?.nativeUiSyncing;
  for (const control of [el.extensionUiSubmit, el.extensionUiCancel, el.extensionUiInput, el.extensionUiEditor, ...el.extensionUiOptions.querySelectorAll("button")]) control.disabled = request.sending || syncing;
  el.extensionUiStatus.textContent = syncing ? tKey("runtime.streamRecovering") : request.sending ? tKey("dialog.sending")
    : request.failed ? tKey("dialog.retry") : tKey("dialog.queued", { count: nativeDialogs.count(request.hostBase, request.sid) });
}
function reconcileNativeDialogs(snapshot, sid) {
  if (rpc?.sid !== sid || rpc.generic) return false;
  try { nativeDialogs.reconcile(apiBase, sid, snapshot); }
  catch { toast(tKey("dialog.invalid"), true); return false; }
  if (extensionUiRequest && !extensionUiRequest.kind && !nativeDialogs.contains(extensionUiRequest)) dismissNativeDialog(extensionUiRequest);
  if (extensionUiRequest && !extensionUiRequest.kind && nativeDialogs.next(apiBase, sid) !== extensionUiRequest) suspendNativeDialog();
  renderNextNativeDialog();
  return true;
}
function renderNextNativeDialog() {
  if (providerAuthRun || !rpc?.sid || rpc.generic) return;
  if (extensionUiRequest) { refreshNativeDialogControls(); return; }
  const next = nativeDialogs.next(apiBase, rpc.sid);
  if (next) renderNativeDialog(next);
}
async function finishExtensionUi(response, expected = extensionUiRequest) {
  const request = extensionUiRequest;
  if (!request || request !== expected) return;
  if (request.kind === "provider-notice") { if (response.cancelled) await cancelProviderAuth(); return; }
  if (request.kind === "provider-auth") {
    if (request.hostBase !== apiBase || providerAuthRun?.runId !== request.runId) return;
    extensionUiRequest = null;
    el.extensionUiSheet.classList.add("hidden");
    el.extensionUiInput.type = "text";
    providerAuthRequest = null;
    el.extensionUiInput.value = "";
    await post("/api/provider-auth/respond", { runId: request.runId, requestId: request.id, ...response })
      .catch((e) => toast(tKey("runtime.providerReplyFailed", { detail: e.message }), true));
    return;
  }
  if (request.hostBase !== apiBase || request.sid !== rpc?.sid) {
    nativeDialogs.complete(request); dismissNativeDialog(request); return;
  }
  if (rpc.nativeUiSyncing) return;
  if (!nativeDialogs.begin(request)) return;
  refreshNativeDialogControls();
  try {
    // No automatic side-effect retry. A timeout can mean an accepted reply
    // whose response was lost; the Host's pending-ID guard decides any retry.
    const result = await api("/api/rpc-ui", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sid: request.sid, id: request.id, ...response }), signal: AbortSignal.timeout(12000) });
    if (result?.sent !== true) throw new Error("Native reply delivery was not confirmed");
    if (nativeDialogs.complete(request)) { dismissNativeDialog(request); renderNextNativeDialog(); }
  } catch (error) {
    if (!nativeDialogs.contains(request) || request.hostBase !== apiBase || request.sid !== rpc?.sid) return;
    if (error.status === 409 || error.status === 404) {
      nativeDialogs.complete(request); dismissNativeDialog(request); renderNextNativeDialog();
    } else { nativeDialogs.failed(request); refreshNativeDialogControls(); }
    toast(tKey("runtime.piReplyFailed", { detail: error.message }), true);
  }
}

function showExtensionUi(ev, sid) {
  const method = ev.method;
  if (method === "notify") {
    toast(ev.message || "Pi 通知", ev.notifyType === "error");
    return;
  }
  if (method === "setStatus") {
    const statusText = stripAnsi(ev.statusText || "").replace(/\s+/g, " ").trim();
    setTaskProgressStatus(ev.statusKey, statusText);
    // Plan/todo status belongs to the compact progress control rather than a
    // transient queue banner. Other extension statuses keep the old banner
    // behavior so existing extensions remain visible in the web client.
    if (TASK_WIDGET_KEY_RE.test(String(ev.statusKey || ""))) return;
    el.queueNote.textContent = statusText;
    el.queueNote.classList.toggle("hidden", !statusText);
    return;
  }
  if (method === "setWidget") {
    setTaskProgressWidget(ev.widgetKey, ev.widgetLines);
    return;
  }
  if (method === "setTitle") {
    if (ev.title) setChatTitle(ev.title);
    return;
  }
  if (!["select", "confirm", "input", "editor"].includes(method)) {
    post("/api/rpc-ui", { sid, id: ev.id, cancelled: true }).catch(() => {});
    return;
  }

  try { nativeDialogs.enqueue(apiBase, sid, ev); }
  catch { toast(tKey("dialog.invalid"), true); return; }
  renderNextNativeDialog();
}

function renderNativeDialog(request) {
  const { event: ev, method } = request;
  extensionUiRequest = request;
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
      button.addEventListener("click", event => { if (event.detail < 2) void finishExtensionUi({ value }, request); });
      el.extensionUiOptions.appendChild(button);
    }
  } else if (method === "confirm") {
    el.extensionUiSubmit.textContent = "確認";
    el.extensionUiSubmit.classList.remove("hidden");
    el.extensionUiSubmit.onclick = event => { if (event.detail < 2) void finishExtensionUi({ confirmed: true }, request); };
  } else if (method === "input") {
    el.extensionUiInput.placeholder = ev.placeholder || "輸入內容";
    el.extensionUiInput.value = request.draft ?? ev.prefill ?? "";
    el.extensionUiInput.classList.remove("hidden");
    el.extensionUiSubmit.textContent = "送出";
    el.extensionUiSubmit.classList.remove("hidden");
    el.extensionUiSubmit.onclick = event => { if (event.detail < 2) void finishExtensionUi({ value: el.extensionUiInput.value }, request); };
  } else if (method === "editor") {
    el.extensionUiEditor.value = request.draft ?? ev.prefill ?? "";
    el.extensionUiEditor.classList.remove("hidden");
    el.extensionUiSubmit.textContent = "完成";
    el.extensionUiSubmit.classList.remove("hidden");
    el.extensionUiSubmit.onclick = event => { if (event.detail < 2) void finishExtensionUi({ value: el.extensionUiEditor.value }, request); };
  }
  el.extensionUiSheet.classList.remove("hidden");
  refreshNativeDialogControls();
  if (method === "input") el.extensionUiInput.focus();
  if (method === "editor") el.extensionUiEditor.focus();
}
el.extensionUiCancel.addEventListener("click", event => {
  if (event.detail >= 2) return;
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
  el.queueNote.textContent = tKey("runtime.stillWorking", { activity: activityStatusText(rpc.activityLabel || "working").replace(/[…\u2026]$/, ""), age: activityAgeText(idle) });
  el.queueNote.classList.add("stale");
  el.queueNote.classList.remove("hidden");
}
function markRpcActivity() {
  if (rpc) rpc.lastEventAt = Date.now();
  if (el.queueNote.classList.contains("stale")) clearActivityNote();
}

// ---------------------------------------------------------------------------
// Run timer: how long the current turn has been working
// ---------------------------------------------------------------------------

// Formatting lives in session-utils so it can be unit tested. Digits are
// monospaced in CSS so the header does not twitch on every tick.
const runElapsedText = (ms) => window.stepsembleSessionUtils.runElapsedText(ms);

function renderRunTimer() {
  if (!el.runTimer) return;
  const startedAt = rpc?.runStartedAt;
  if (!startedAt) {
    el.runTimer.classList.add("hidden");
    el.runTimer.textContent = "";
    return;
  }
  const endedAt = rpc?.streaming ? Date.now() : (rpc?.runEndedAt || Date.now());
  el.runTimer.textContent = runElapsedText(endedAt - startedAt);
  el.runTimer.classList.remove("hidden");
  el.runTimer.classList.toggle("running", !!rpc?.streaming);
}

function startRunTimer(startedAt = Date.now()) {
  if (!rpc) return;
  // A reconnect reports the real start time, so an in-flight run keeps its
  // own elapsed time instead of restarting from zero.
  rpc.runStartedAt = Number.isFinite(Number(startedAt)) ? Number(startedAt) : Date.now();
  rpc.runEndedAt = null;
  renderRunTimer();
  if (runTimerInterval) return;
  runTimerInterval = setInterval(renderRunTimer, 1000);
}

function stopRunTimer() {
  if (runTimerInterval) {
    clearInterval(runTimerInterval);
    runTimerInterval = null;
  }
  // The final duration stays visible: it answers "how long did that take?"
  // once the answer has already arrived.
  if (rpc?.runStartedAt && !rpc.runEndedAt) rpc.runEndedAt = Date.now();
  renderRunTimer();
}
const ACTIVITY_STATUS_KEYS = Object.freeze({
  thinking: "Thinking…",
  working: "Working…",
  writing: "Writing…",
  waiting: "Waiting for your response",
  retrying: "Retrying…",
  compacting: "Compacting…",
});
function activityStatusText(label) {
  const key = ACTIVITY_STATUS_KEYS[label] || ACTIVITY_STATUS_KEYS.working;
  return window.stepsembleI18n?.t(key) || key;
}
function setActivityLabel(label = "thinking") {
  const statusText = activityStatusText(label);
  if (el.thinkingStatus) {
    el.thinkingStatus.textContent = statusText;
    el.thinkingStatus.classList.toggle("hidden", !rpc?.streaming);
    el.thinkingStatus.classList.toggle("running", !!rpc?.streaming && label !== "waiting");
  }
  if (rpc) rpc.activityLabel = label;
  if (pendingAssistant?.shimmerLabel) pendingAssistant.shimmerLabel.textContent = statusText;

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
  renderTaskProgress();
}

function handleRpcEvent(ev, eventSid = rpc?.sid) {
  if (eventSid && rpc?.sid !== eventSid) return;
  markRpcActivity();
  switch (ev.type) {
    case "agent_start":
      startActivityRun();
      runFailureRendered = false;
      lastRunFailure = null;
      // A fresh turn restarts the clock. A reconnect replays this same event
      // for a run already in flight, and there the server-provided start time
      // must win: otherwise the timer would restart at zero on every reload.
      if (rpc && !(rpc.streaming && rpc.runStartedAt)) {
        rpc.runStartedAt = Date.now();
        rpc.runEndedAt = null;
      }
      setStreaming(true);
      setActivityLabel("thinking");
      clearActivityNote();
      el.queueNote.classList.add("hidden");
      break;
    case "message_start":
      if (ev.message?.role === "user") {
        // The user message is persisted before this event fires, so a session
        // created for a brand-new chat now exists on disk; the sidebar can
        // pick it up without a manual reload.
        scheduleSessionListRefresh();
      } else if (ev.message?.role === "assistant") {
        ensurePendingAssistant();
      }
      break;
    case "extension_ui_request":
      // setStatus/setWidget/setTitle are fire-and-forget display updates, not
      // a request for user input. Keep the Running indicator animated for
      // those events; only interactive extension UI should pause it.
      if (!["setStatus", "setWidget", "setTitle"].includes(ev.method)) setActivityLabel("waiting");
      showExtensionUi(ev, eventSid);
      break;
    case "extension_ui_closed":
      nativeDialogs.remove(apiBase, eventSid, ev.id);
      if (extensionUiRequest?.sid === eventSid && extensionUiRequest.id === ev.id && extensionUiRequest.hostBase === apiBase) {
        dismissNativeDialog(extensionUiRequest);
      }
      renderNextNativeDialog();
      break;
    case "auto_retry_start":
      setStreaming(true);
      setActivityLabel("retrying");
      el.queueNote.textContent = tKey("runtime.retryAttempt", { attempt: ev.attempt || 1, total: ev.maxAttempts || "…" });
      el.queueNote.classList.remove("hidden");
      break;
    case "auto_retry_end":
      if (ev.success === false) {
        if (!runFailureRendered) {
          renderRunFailure(lastRunFailure || {
            stopReason: "error",
            errorMessage: ev.finalError || tKey("runtime.retryFailed"),
          });
        }
        el.queueNote.textContent = tKey("runtime.retryFailedHint");
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
      markContextStatsAwaiting();
      // Pi reports null contextUsage tokens/percent immediately after this
      // event; fetch now so the dashboard honestly shows the transient unknown
      // state and is refreshed again after the next settled assistant reply.
      void syncSessionStats(eventSid);
      break;
    case "summarization_retry_scheduled":
      setActivityLabel("retrying");
      el.queueNote.textContent = tKey("runtime.compactRetrying");
      el.queueNote.classList.remove("hidden");
      break;
    case "summarization_retry_attempt_start":
      setActivityLabel("retrying");
      el.queueNote.textContent = tKey("runtime.compactAttempt", { attempt: ev.attempt || 1 });
      el.queueNote.classList.remove("hidden");
      break;
    case "summarization_retry_finished":
      if (ev.success === false || ev.willRetry === false) {
        el.queueNote.textContent = ev.success === false
          ? tKey("runtime.compactFailed")
          : tKey("runtime.compactDone");
        el.queueNote.classList.remove("hidden");
      }
      break;
    case "extension_error":
      el.queueNote.textContent = tKey("runtime.extensionError", { detail: ev.message || ev.error || tKey("runtime.unknownError") });
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
        // message_end.message is the authoritative assistant snapshot. The
        // request is coalesced if another lifecycle trigger is already waiting.
        void syncSessionStats(eventSid);
        const current = pendingAssistant;
        const full = wireFromAgentMessage(m);
        updateTaskProgressFromAssistant(full.text, { running: !!rpc?.streaming || full.toolCalls.length > 0 });
        noteRunFinalResponse(full);
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
      if (ended) updateTaskProgressFromAssistant(ended.text, { running: !!rpc?.streaming });
      if (isFailureMessage(ended)) {
        lastRunFailure = ended;
      }
      break;
    }
    case "agent_end": {
      const endedMessages = (Array.isArray(ev.messages) ? ev.messages : [])
        .map(wireFromAgentMessage);
      for (const message of endedMessages) updateTaskProgressFromAssistant(message.text, { running: !!ev.willRetry });
      const failed = endedMessages.find(isFailureMessage);
      if (!failed) break;
      lastRunFailure = failed;
      if (ev.willRetry) {
        // agent_end is an intermediate lifecycle boundary when Pi will retry
        // or compact. Do not settle the receipt here.
        setActivityLabel("retrying");
        const detail = String(failed.errorMessage || tKey("runtime.temporaryFailure")).trim();
        el.queueNote.textContent = tKey("runtime.modelRetrying", { detail: detail.slice(0, 260) });
        el.queueNote.classList.remove("hidden");
      } else {
        setRunOutcome(failed.stopReason === "aborted" ? "interrupted" : "failed", failed);
        if (!runFailureRendered) renderRunFailure(failed);
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
      // This terminal boundary catches runs that ended without a normal
      // assistant message_end and makes the settled dashboard authoritative.
      void syncSessionStats(eventSid);
      scheduleSessionListRefresh();
      if (lastRunFailure && !runFailureRendered) renderRunFailure(lastRunFailure);
      if (activeActivityRun) {
        if (lastRunFailure) setRunOutcome(lastRunFailure.stopReason === "aborted" ? "interrupted" : "failed", lastRunFailure);
        const receipt = settleActivityRun(activeActivityRun);
        // Keep a settled run object until the next agent_start so late
        // message_end/tool events cannot mutate its receipt.
        if (receipt) refreshActivityReceipts();
      }
      settleTaskProgress();
      setStreaming(false);
      finalizePending({ settleTools: true });
      el.queueNote.classList.add("hidden");
      clearActivityNote();
      break;
    case "response":
      if (ev.command === "get_state" && ev.success) {
        applyComposerState(ev.data);
        if (ev.data?.sessionFile) trackCurrentSessionFile(ev.data.sessionFile);
      }
      if ((ev.command === "set_model" || ev.command === "cycle_model") && ev.success) {
        void syncComposerState(eventSid);
        void syncSessionStats(eventSid);
      }
      break;
    case "rpc_exit":
      resetNativeDialogs();
      // A process exit is also a terminal run boundary when the peer closes
      // before agent_settled. The request may fail, but the identity guards
      // keep a late response from a replaced session out of the dashboard.
      void syncSessionStats(eventSid);
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
        const unexpectedExit = piSession.unexpectedExit(ev);
        if (activeActivityRun && !activeActivityRun.settled) {
          setRunOutcome("interrupted", { errorMessage: ev.error || ev.stderrTail || "" });
          settleActivityRun(activeActivityRun, "interrupted");
        }
        settleTaskProgress();
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
  if (m.usage) out.usage = normalizeWireUsage(m.usage);
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
      ? tKey("runtime.runStopped")
      : tKey("runtime.noErrorReason")
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
  const groups = runActivityGroups(activeActivityRun);
  const activity = groups[groups.length - 1] || null;
  const runBubble = activity?.details?.closest(".bubble");
  const runWrap = runBubble?.closest(".msg");
  if (runWrap && runBubble) return { wrap: runWrap, bubble: runBubble };
  return null;
}

function renderRunFailure(data = {}, options = {}) {
  const shell = options.shell || assistantShellForError() || makeMsgShell("assistant", "pi");
  const groups = runActivityGroups(activeActivityRun);
  const activity = pendingAssistant?.activity || liveActivity || groups[groups.length - 1] || null;
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
      text: incomplete ? tKey("runtime.runStoppedEarly") : output,
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
  el.btnAbort.disabled = !!rpc?.stopPending;
  if (rpc) rpc.streaming = on;
  const generic = !!rpc?.generic;
  setTaskProgressRunState(!!on);
  if (on) {
    if (rpc && !rpc.lastEventAt) rpc.lastEventAt = Date.now();
    if (!activityWatchdog) activityWatchdog = setInterval(updateActivityWatchdog, 5000);
    if (el.thinkingStatus) setActivityLabel(rpc?.activityLabel || "thinking");
    startRunTimer(rpc?.runStartedAt || Date.now());
  } else if (activityWatchdog) {
    clearInterval(activityWatchdog);
    activityWatchdog = null;
    clearActivityNote();
  }
  if (!on) stopRunTimer();
  el.thinkingStatus?.classList.toggle("hidden", !on);
  el.thinkingStatus?.classList.toggle("running", !!on && rpc?.activityLabel !== "waiting");
  el.btnAbort.classList.toggle("hidden", !on);
  // Interactive CLI agents accept follow-up input while they are alive, so
  // keep Send available for them. Pi's native RPC retains its queue/abort UX.
  el.btnSend.classList.toggle("hidden", on && !generic);
  el.btnModel?.classList.toggle("hidden", generic);
  el.btnImg?.classList.toggle("hidden", generic);
  el.contextDashboard?.classList.toggle("hidden", generic);
  el.btnSend.title = on ? "" : (window.stepsembleI18n?.t("Send") || "Send");
  el.btnAbort.title = on ? (window.stepsembleI18n?.t("Stop") || "Stop") : "";
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
  resizeComposerInput();
  saveActiveDraft();
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
  const generic = !!rpc.generic;
  if (generic && pendingImages.length) {
    toast(agentHubText("cliTextOnly"), true);
    return;
  }
  const sendDraftKey = activeDraftKey;
  el.input.value = "";
  el.input.style.height = "auto";
  el.slashMenu.classList.add("hidden");
  slashState = null;

  // 內建 TUI 指令映射（/compact 等 RPC 專屬）
  const bm = !generic && text.match(/^\/(compact|clear)\s*$/i);
  if (bm) {
    const cmd = bm[1].toLowerCase();
    if (cmd === "compact") { await BUILTIN_SLASH.compact(); removeDraftForKey(sendDraftKey); return; }
    if (cmd === "clear") { removeDraftForKey(sendDraftKey); showList(); return; }
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
    const result = generic
      ? await post("/api/agent/send", { taskId: sendSid, message: text })
      : await post("/api/send", { sid: sendSid, message: text, images }); // /skill:xxx 等直接透傳，pi 原生處理
    removeDraftForKey(sendDraftKey);
    if (result?.queued && rpc?.sid === sendSid) {
      el.queueNote.dataset.persistent = "queue";
      el.queueNote.textContent = tKey("runtime.messageQueued");
      el.queueNote.classList.remove("hidden");
    }
  } catch (e) {
    if (rpc?.sid === sendSid) {
      el.input.value = text;
      resizeComposerInput();
      saveDraftForKey(sendDraftKey, text);
      pendingImages = images.concat(pendingImages).slice(0, 4);
      renderImgPreview();
      toast(tKey("runtime.messageNotSent"), true);
    }
  }
}
el.btnAbort.addEventListener("click", async () => {
  if (!rpc) return;
  const connection = rpc, base = apiBase;
  if (connection.stopPending) return;
  connection.stopPending = true;
  el.btnAbort.disabled = true;
  try {
    if (connection.generic) await post("/api/agent/abort", { taskId: connection.sid });
    else await post("/api/abort", { sid: connection.sid });
  } catch (error) {
    if (rpc === connection && apiBase === base) toast(error.message || agentHubText("taskStopFailed"), true);
  } finally {
    connection.stopPending = false;
    if (rpc === connection && apiBase === base) el.btnAbort.disabled = false;
  }
});

// ---- chat ⋯ menu：重命名目前 session / 返回列表 ----
el.btnChatMenu.addEventListener("click", () => {
  if (currentSessionFile) { openSessionActions({ ...actionStubFrom(currentSessionFile) }); }
  else toast(tKey("runtime.newChatNeedsMessage"));
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
    if (hit) { currentSessionFile = hit.file; promoteDraftScope(hit.file); rememberLastChat(hit.file); return; }
  }
  currentSessionFile = absPath;
  promoteDraftScope(absPath);
  rememberLastChat(absPath);
  // 新對話首次寫檔時列表尚未有它，重新掃描後再把絕對路徑解析成相對 session file。
  refreshSessions().then(() => {
    const hit = sessionsCache.find((s) => {
      const relative = String(s.file || "").replaceAll("\\", "/").replace(/^\/+/, "");
      return normalized.endsWith("/" + relative) || normalized === relative;
    });
    if (hit) {
      currentSessionFile = hit.file;
      promoteDraftScope(hit.file);
      rememberLastChat(hit.file);
      renderSessionList(el.search.value);
    }
  }).catch(() => {});
}

// ---- ⋯ 菜單：模型與推理入口 ----
function resetComposerSummary() {
  composerModelName = "";
  composerReasoningLevel = "off";
  resetContextDashboard();
  updateComposerSummary();
}
function updateComposerSummary(modelName, thinkingLevel) {
  if (modelName !== undefined) composerModelName = String(modelName || "");
  if (thinkingLevel) composerReasoningLevel = String(thinkingLevel);
  const model = composerModelName || (window.stepsembleI18n?.t("Server default") || "Server default");
  const level = composerReasoningLevel || "off";
  const summary = `${model} · ${level}`;
  // The chip is fixed-width: the model name truncates with an ellipsis while
  // the trailing thinking level always stays fully visible.
  if (el.composerModelNameText) {
    el.composerModelNameText.textContent = model;
    el.composerModelNameText.title = model;
  }
  if (el.composerModelLevelText) el.composerModelLevelText.textContent = `· ${level}`;
  if (el.btnModel) {
    const label = window.stepsembleI18n?.t("Model & reasoning") || "Model & reasoning";
    el.btnModel.title = label;
    el.btnModel.setAttribute("aria-label", `${label}: ${summary}`);
  }
}
function applyComposerState(data) {
  const model = data?.model;
  const modelName = model?.name || model?.id || "";
  const level = data?.thinkingLevel || "off";
  if (data && Object.prototype.hasOwnProperty.call(data, "model")) {
    composerModelContextWindow = positiveFinite(model?.contextWindow);
    if (contextStats) {
      contextStats = {
        ...contextStats,
        contextCapacity: mergeContextCapacity(contextStats.contextUsage, composerModelContextWindow),
      };
    }
  }
  el.thinkingSelect.value = level;
  updateComposerSummary(modelName, level);
  renderContextDashboard();
  void syncThinkingLevelSupport(model, level);
}

// Thinking levels are clamped per model in Pi: a model without the reasoning
// flag only ever reports "off", and set_thinking_level silently clamps to it.
// Track what each model supports, grey out unsupported options, and restore
// the user's last chosen level when a session or model switch drops it.
const THINKING_PREFERENCE_KEY = "stepsemble.thinkingLevel";
const LEGACY_THINKING_PREFERENCE_KEYS = Object.freeze(["piHarbor.thinkingLevel", "piWeb.thinkingLevel"]);
let composerModelKey = "";
let thinkingLevelsForModel = new Map(); // provider/id → available levels
let thinkingRestoreInFlight = false;

function thinkingPreference() {
  try { return migratedStorageValue(localStorage, THINKING_PREFERENCE_KEY, LEGACY_THINKING_PREFERENCE_KEYS) || ""; } catch { return ""; }
}

function rememberThinkingPreference(level) {
  try { localStorage.setItem(THINKING_PREFERENCE_KEY, String(level)); } catch {}
}

function updateThinkingSelectOptions() {
  if (!el.thinkingSelect) return;
  const levels = thinkingLevelsForModel.get(composerModelKey) || null;
  for (const option of el.thinkingSelect.options) {
    option.disabled = !!levels && !levels.includes(option.value);
  }
}

async function syncThinkingLevelSupport(model, reportedLevel) {
  const key = model ? `${model.provider || ""}/${model.id || ""}` : "";
  composerModelKey = key;
  if (!key) return;
  if (!thinkingLevelsForModel.has(key)) {
    const expectedSid = rpc?.sid;
    try {
      const r = await rpcCmd(expectedSid, { type: "get_available_thinking_levels" });
      if (rpc?.sid !== expectedSid || !r?.success) return;
      const levels = Array.isArray(r.data?.levels) ? r.data.levels.map(String) : null;
      if (levels) thinkingLevelsForModel.set(key, levels);
    } catch { return; }
  }
  if (el.thinkingSelect) {
    updateThinkingSelectOptions();
    if (reportedLevel) el.thinkingSelect.value = reportedLevel;
  }
  // Pi drops the level whenever the session restarts on a model that does not
  // advertise the stored level (new session, model switch, RPC respawn). Re-
  // apply the user's last deliberate choice when the model still supports it.
  const stored = thinkingPreference();
  if (!stored || thinkingRestoreInFlight || reportedLevel === stored) return;
  const levels = thinkingLevelsForModel.get(key);
  if (!levels || !levels.includes(stored)) return;
  const expectedSid = rpc?.sid;
  thinkingRestoreInFlight = true;
  try {
    const r = await rpcCmd(expectedSid, { type: "set_thinking_level", level: stored });
    if (rpc?.sid === expectedSid && r?.success !== false) {
      el.thinkingSelect.value = stored;
      updateComposerSummary(undefined, stored);
    }
  } catch {}
  finally { thinkingRestoreInFlight = false; }
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

// ---- Context details popover ----
function setContextPopover(open) {
  el.contextPopover?.classList.toggle("hidden", !open);
  el.contextInfo?.setAttribute("aria-expanded", String(!!open));
}

el.contextInfo?.addEventListener("click", (event) => {
  event.stopPropagation();
  setContextPopover(!!el.contextPopover?.classList.contains("hidden"));
});
document.addEventListener("click", (event) => {
  if (!el.contextPopover || el.contextPopover.classList.contains("hidden")) return;
  if (event.target instanceof Element && event.target.closest("#context-popover, #context-info")) return;
  setContextPopover(false);
});

let availableModels = [];
let modelSheetCurrentId = null;
let modelSheetCurrentProvider = null;
// Mirrors pi's getSupportedThinkingLevels: standard levels through "high" are
// available on every reasoning model; "xhigh"/"max" require a non-null map
// entry. The badge answers "how deep can this model think" before picking it.
function modelThinkingBadge(model) {
  if (!model?.reasoning) return "";
  const map = model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? model.thinkingLevelMap : null;
  if (map?.max) return "max";
  if (map?.xhigh) return "xhigh";
  return "high";
}
async function openModelSheet() {
  const expectedSid = rpc?.sid;
  if (!expectedSid) { toast("對話未開啟"); return; }
  el.modelSheet.classList.remove("hidden");
  if (el.modelSearch) { el.modelSearch.value = ""; }
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
    let currentId = null, currentProvider = null, curThinking = null;
    if (stateRes.status === "fulfilled" && stateRes.value && stateRes.value.success) {
      currentId = (stateRes.value.data && stateRes.value.data.model && stateRes.value.data.model.id) || null;
      currentProvider = (stateRes.value.data && stateRes.value.data.model && stateRes.value.data.model.provider) || null;
      curThinking = stateRes.value.data ? stateRes.value.data.thinkingLevel : null;
      applyComposerState(stateRes.value.data);
    }
    renderModelList(currentId, currentProvider);
    if (curThinking) el.thinkingSelect.value = curThinking;
  } catch (e) {
    el.modelList.innerHTML = "";
    const error = document.createElement("p");
    error.className = "model-load-error";
    error.textContent = tKey("runtime.loadFailed", { detail: e.message || "unknown error" });
    el.modelList.appendChild(error);
  }
}

function renderModelList(currentId, currentProvider = null) {
  modelSheetCurrentId = currentId;
  modelSheetCurrentProvider = currentProvider;
  // Selection must match on provider+id: the same model id can be offered by
  // several providers (e.g. glm-5.3-flash on both ollama-cloud and
  // opencode-go), and id-only matching ticks every duplicate row at once.
  // When provider info is missing on either side, fall back to id-only
  // matching so the previous behaviour survives degraded payloads.
  const matchesCurrent = (m) => m.id === currentId
    && (currentProvider == null || m.provider == null || m.provider === currentProvider);
  const current = availableModels.find(matchesCurrent);
  const query = String(el.modelSearch?.value || "").trim().toLocaleLowerCase();
  const visibleModels = availableModels.filter(isModelVisible).filter((m) => !query
    || `${m.name || ""} ${m.id || ""} ${m.provider || ""}`.toLocaleLowerCase().includes(query));
  updateComposerSummary(current ? (current.name || current.id) : "", undefined);
  el.modelList.innerHTML = "";
  if (!visibleModels.length) {
    // Build the node instead of interpolating: the copy is translated at
    // runtime and must never be parsed as markup.
    const empty = document.createElement("p");
    empty.style.cssText = "padding:12px 4px;color:var(--pine-soft);font-size:13.5px";
    empty.textContent = tKey(query ? "runtime.noMatchingModels" : "runtime.noVisibleModels");
    el.modelList.appendChild(empty);
    return;
  }
  for (const m of visibleModels) {
    const row = document.createElement("button");
    row.className = "action-row model-row" + (matchesCurrent(m) ? " active" : "");
    row.type = "button";
    row.innerHTML = '<span class="model-check"></span><span class="model-info"><strong></strong><small></small></span><span class="model-thinking-badge"></span>';
    row.querySelector(".model-check").textContent = matchesCurrent(m) ? "✓" : "";
    row.querySelector("strong").textContent = m.name || m.id;
    row.querySelector("small").textContent = (m.provider || "?") + (m.contextWindow ? " · " + Math.round(m.contextWindow/1000) + "k ctx" : "");
    row.querySelector(".model-thinking-badge").textContent = modelThinkingBadge(m);
    row.addEventListener("click", async () => {
      const expectedSid = rpc?.sid;
      if (!expectedSid) return;
      try {
        const result = await rpcCmd(expectedSid, { type: "set_model", provider: m.provider, modelId: m.id });
        if (!rpc || rpc.sid !== expectedSid) return;
        if (result?.success === false) throw new Error(result.error || "RPC rejected");
        // Re-read get_state for the selected model's capacity; only that
        // state response is used as the dashboard's capacity fallback.
        void syncComposerState(expectedSid);
        void syncSessionStats(expectedSid);
        toast("模型：" + (m.name || m.id));
        updateComposerSummary(m.name || m.id, undefined);
        renderModelList(m.id, m.provider);
        // 頂部 sub 同步
        el.chatSub.dataset.base = currentSessionCwd + " · " + (m.name || m.id); updateLiveUsage(null);
      } catch (e) { toast(tKey("runtime.switchFailed", { detail: e.message }), true); }
    });
    el.modelList.appendChild(row);
  }
}

// ---- Command palette (Cmd/Ctrl+K): jump to sessions, models, machines ----
let commandItems = [];
let commandIndex = 0;

function commandKindLabel(kind) {
  return kind === "session" ? "Session" : kind === "model" ? "Model" : kind === "machine" ? "Device" : "";
}

function renderCommandResults() {
  if (!el.commandResults) return;
  const query = String(el.commandInput?.value || "").trim().toLocaleLowerCase();
  const matches = commandItems.filter((item) => !query || item.label.toLocaleLowerCase().includes(query));
  commandIndex = Math.max(0, Math.min(commandIndex, matches.length - 1));
  el.commandResults.innerHTML = "";
  if (!matches.length) {
    const empty = document.createElement("p");
    empty.className = "command-empty";
    empty.textContent = "找不到符合項目";
    el.commandResults.appendChild(empty);
    return;
  }
  matches.slice(0, 40).forEach((item, index) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "command-row" + (index === commandIndex ? " active" : "");
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(index === commandIndex));
    const tag = document.createElement("span");
    tag.className = "command-tag";
    tag.textContent = item.tag || commandKindLabel(item.kind) || "·";
  const label = document.createElement("span");
  label.className = "command-label";
  label.textContent = item.label;
  // Session and machine names are user content: phrase-substitution would
  // mangle them (seen as "——， ollama-cloud ，："). Actions and models keep
  // translating; names do not.
  if (item.kind === "session" || item.kind === "machine") label.dataset.i18nIgnore = "";
  row.append(tag, label);
    row.addEventListener("click", () => runCommandItem(item));
    el.commandResults.appendChild(row);
  });
  el.commandResults.querySelector(".command-row.active")?.scrollIntoView({ block: "nearest" });
}

function runCommandItem(item) {
  closeCommandPalette();
  try { item.run(); } catch (error) { toast(error.message || "Action failed", true); }
}

function moveCommandSelection(delta) {
  const query = String(el.commandInput?.value || "").trim().toLocaleLowerCase();
  const matches = commandItems.filter((item) => !query || item.label.toLocaleLowerCase().includes(query));
  if (!matches.length) return;
  commandIndex = (commandIndex + delta + matches.length) % matches.length;
  renderCommandResults();
}

function buildCommandItems() {
  const items = [];
  items.push({ kind: "action", tag: "⌘", label: window.stepsembleI18n?.t("New session") || "New session", run: () => { if (!el.newDialog.classList.contains("hidden")) return; if (sessionsCache.length) el.btnNew?.click(); else el.btnNewProject?.click(); } });
  items.push({ kind: "action", tag: "⌘", label: window.stepsembleI18n?.t("Open Settings") || "Open Settings", run: () => showSettings() });
  items.push({ kind: "action", tag: "⌘", label: settings.showTemporarySessions
    ? (window.stepsembleI18n?.t("Hide Sub Agent sessions") || "Hide Sub Agent sessions")
    : (window.stepsembleI18n?.t("Show Sub Agent sessions") || "Show Sub Agent sessions"),
    run: () => { settings = saveSettings({ showTemporarySessions: !settings.showTemporarySessions }); renderTemporarySessionFilter(temporarySessionCount); refreshSessions(); } });
  const sessions = [...sessionsCache]
    .sort((a, b) => (Number(b.mtimeMs) || 0) - (Number(a.mtimeMs) || 0))
    .slice(0, 30);
  for (const s of sessions) {
    const name = sessionDisplayTitle(s).slice(0, 70);
    items.push({ kind: "session", label: name, run: () => openExisting(s) });
  }
  for (const m of machines) {
    items.push({ kind: "machine", tag: "⇄", label: m.name || m.id || m.host || String(m.id || ""), run: () => switchMachine(m.id) });
  }
  // Long-page jump targets: Settings has 12 groups, so a phone user should not
  // scroll through all of them to reach Providers.
  for (const [label, target] of [["Devices", "devices"], ["Access tokens", "tokens"], ["Connection", "connection"], ["Appearance", "appearance"], ["About", "about"]]) {
    items.push({
      kind: "action", tag: "→",
      label: (window.stepsembleI18n?.t("Settings") || "Settings") + " → " + label,
      run: () => openSettingsSection(target),
    });
  }
  return items;
}

async function openCommandPalette() {
  if (!el.commandPalette) return;
  commandIndex = 0;
  if (el.commandInput) el.commandInput.value = "";
  commandItems = buildCommandItems();
  renderCommandResults();
  el.commandPalette.classList.remove("hidden");
  el.commandInput?.focus({ preventScroll: true });
  // Models come from the live RPC; append them once the catalog answers so
  // opening the palette stays instant.
  if (rpc?.sid) {
    const expectedSid = rpc.sid;
    try {
      const r = await rpcCmd(expectedSid, { type: "get_available_models" });
      if (rpc?.sid === expectedSid && r?.success && el.commandPalette && !el.commandPalette.classList.contains("hidden")) {
        const models = (r.data?.models || []).filter((m) => isModelVisible(m)).slice(0, 60);
        const modelItems = models.map((m) => ({
          kind: "model",
          label: `${m.name || m.id} · ${m.provider || "?"}`,
          run: () => {
            const expected = rpc?.sid;
            if (!expected) return;
            rpcCmd(expected, { type: "set_model", provider: m.provider, modelId: m.id })
              .then(() => { toast("模型：" + (m.name || m.id)); void syncComposerState(expected); })
              .catch((error) => toast(tKey("runtime.switchFailed", { detail: error.message || "" }), true));
          },
        }));
        commandItems = [...commandItems.slice(0, 3), ...modelItems, ...commandItems.slice(3)];
        renderCommandResults();
      }
    } catch {}
  }
}

function closeCommandPalette() {
  el.commandPalette?.classList.add("hidden");
  if (el.commandInput) el.commandInput.value = "";
}

function toggleCommandPalette() {
  if (!el.commandPalette) return;
  if (el.commandPalette.classList.contains("hidden")) void openCommandPalette();
  else closeCommandPalette();
}

// Settings is one long page on purpose; the palette gives it jump targets so
// a phone user can reach Providers without scrolling through Devices.
function openSettingsSection(target) {
  showSettings();
  setTimeout(() => {
    document.querySelector('[data-settings-target="' + String(target).replace(/"/g, "") + '"]')
      ?.scrollIntoView({ behavior: settings.reducedMotion ? "auto" : "smooth", block: "start" });
  }, 300);
}

el.commandInput?.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") { event.preventDefault(); moveCommandSelection(1); }
  else if (event.key === "ArrowUp") { event.preventDefault(); moveCommandSelection(-1); }
  else if (event.key === "Enter") {
    event.preventDefault();
    const query = String(el.commandInput?.value || "").trim().toLocaleLowerCase();
    const matches = commandItems.filter((item) => !query || item.label.toLocaleLowerCase().includes(query));
    const item = matches[commandIndex];
    if (item) runCommandItem(item);
  }
});
// Live filtering: the palette only re-rendered on open and Enter before, so
// typing appeared to do nothing until the query was submitted.
el.commandInput?.addEventListener("input", () => { commandIndex = 0; renderCommandResults(); });
el.commandResults?.addEventListener("click", (event) => {
  if (event.target === el.commandResults) closeCommandPalette();
});

function closeModelSheet() { el.modelSheet.classList.add("hidden"); }
el.modelClose.addEventListener("click", closeModelSheet);
el.modelSearch?.addEventListener("input", () => renderModelList(modelSheetCurrentId, modelSheetCurrentProvider));
el.modelSheet.addEventListener("click", (event) => {
  if (event.target === el.modelSheet) closeModelSheet();
});
async function changeThinkingLevel(level) {
  const expectedSid = rpc?.sid;
  if (!expectedSid) return;
  try {
    const r = await rpcCmd(expectedSid, { type: "set_thinking_level", level });
    if (!rpc || rpc.sid !== expectedSid) return;
    if (r && r.success === false) throw new Error(r.error || "RPC rejected");
    rememberThinkingPreference(level);
    // Pi clamps the level to the model's capabilities, so re-read the state
    // instead of trusting the requested value in the UI.
    const state = await rpcCmd(expectedSid, { type: "get_state" });
    if (rpc?.sid !== expectedSid) return;
    const actual = state?.success ? state.data?.thinkingLevel || "off" : level;
    el.thinkingSelect.value = actual;
    updateComposerSummary(undefined, actual);
    if (actual !== level) {
      const model = state?.success ? state.data?.model : null;
      toast(window.stepsembleI18n?.t("{model} does not support {level} thinking; using {actual}", {
        model: model?.name || model?.id || "",
        level,
        actual,
      }) || `${level} → ${actual}`, true);
    } else {
      toast(tKey("runtime.thinkingLevel", { level }));
    }
  } catch (e) { toast(tKey("runtime.saveFailed", { detail: e.message }), true); }
}
el.thinkingSelect.addEventListener("change", () => changeThinkingLevel(el.thinkingSelect.value));

// ===========================================================================
// Markdown / Mermaid Rich 渲染
// ===========================================================================

const HAS_MD = typeof marked !== "undefined" && typeof DOMPurify !== "undefined";
let mermaidReady = false, mermaidLoading = null;
// Mermaid ships inside the app (public/vendor/mermaid.min.js): diagram sources
// never leave the machine and rendering works fully offline. The UMD build is
// injected lazily on first diagram so the initial page load stays light.
function ensureMermaid() {
  if (mermaidReady || mermaidLoading) return mermaidLoading;
  mermaidLoading = new Promise((resolve) => {
    const existing = window.mermaid;
    if (existing) { resolve(existing); return; }
    const script = document.createElement("script");
    // Keep the request identical to the service-worker pre-cache entry; the
    // release-specific cache name already provides asset versioning.
    script.src = "/vendor/mermaid.min.js";
    script.async = true;
    script.onload = () => resolve(window.mermaid || null);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  })
    .then((mermaid) => {
      if (!mermaid) { mermaidLoading = null; return null; }
      mermaid.initialize({ securityLevel: "strict", startOnLoad: false, theme: document.documentElement.dataset.theme === "dark" || (settings.theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "neutral", fontFamily: "-apple-system, sans-serif" });
      mermaidReady = true;
      return mermaid;
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
  el.input.dispatchEvent(new Event("input", { bubbles: true }));
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
      else toast(tKey("runtime.compactCommandFailed", { detail: r.error || "unknown" }), true);
    } catch (e) { toast(tKey("runtime.compactCommandFailed", { detail: e.message }), true); }
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
function maybeDateSeparator(ts, container = el.messages) {
  if (!ts) return;
  const d = new Date(ts);
  const key = d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate();
  if (_lastMsgDate === key) return;
  _lastMsgDate = key;
  const div = document.createElement("div");
  div.className = "date-sep";
  div.textContent = `${d.getMonth() + 1}/${d.getDate()}`;
  container.appendChild(div);
  if (container === el.messages) keepSessionUsageAtEnd();
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

// Settings is a full-screen overlay on touch layouts. Keep its edge gesture
// deliberately narrower than ordinary scrolling and form interaction: only a
// rightward, mostly-horizontal movement that starts at the left edge can take
// the overlay away.
(() => {
  const EDGE = 36;
  const DIST = 90;
  const RATIO = 1.6;
  let gesture = null;

  const reducedMotion = () => document.documentElement.classList.contains("reduced-motion")
    || matchMedia("(prefers-reduced-motion: reduce)").matches;

  el.viewSettings.addEventListener("touchstart", (event) => {
    if (el.viewSettings.classList.contains("hidden") || event.touches.length !== 1) return;
    const target = event.target;
    if (target.closest?.("input, select, textarea, button, a, label, summary, [contenteditable=\"true\"], option")) return;
    const touch = event.touches[0];
    if (touch.clientX > EDGE) return;
    if (settingsSwipeTimer) clearTimeout(settingsSwipeTimer);
    if (settingsSlideTimer) clearTimeout(settingsSlideTimer);
    settingsSwipeTimer = null;
    settingsSlideTimer = null;
    el.viewSettings.classList.remove("slide-in", "snap-back");
    gesture = { x0: touch.clientX, y0: touch.clientY, t0: Date.now(), dx: 0, active: false };
  }, { passive: true });

  el.viewSettings.addEventListener("touchmove", (event) => {
    if (!gesture) return;
    if (event.touches.length !== 1) {
      gesture = null;
      el.viewSettings.classList.remove("dragging");
      el.viewSettings.style.transform = "";
      return;
    }
    const touch = event.touches[0];
    const dx = touch.clientX - gesture.x0;
    const dy = touch.clientY - gesture.y0;
    if (!gesture.active) {
      if (dx > 12 && Math.abs(dx) > Math.abs(dy) * RATIO) {
        gesture.active = true;
        el.viewSettings.classList.add("dragging");
      } else if (Math.abs(dy) > 14) {
        gesture = null;
        return;
      }
    }
    if (gesture.active) {
      event.preventDefault();
      gesture.dx = Math.max(0, dx);
      el.viewSettings.style.transform = `translateX(${gesture.dx}px)`;
    }
  }, { passive: false });

  function finish(cancelled = false) {
    if (!gesture) return;
    const current = gesture;
    gesture = null;
    if (!current.active) return;
    el.viewSettings.classList.remove("dragging");
    const elapsed = Math.max(1, Date.now() - current.t0);
    const velocity = current.dx / elapsed;
    const fast = current.dx > 40 && (elapsed < 260 || velocity >= 0.65);
    if (!cancelled && (current.dx > DIST || fast)) {
      if (reducedMotion()) {
        hideSettings();
        return;
      }
      el.viewSettings.classList.add("slide-out");
      el.viewSettings.style.transform = "translateX(100%)";
      settingsSwipeTimer = setTimeout(() => {
        settingsSwipeTimer = null;
        hideSettings();
      }, 230);
      return;
    }
    el.viewSettings.classList.add("snap-back");
    el.viewSettings.style.transform = "";
    settingsSwipeTimer = setTimeout(() => {
      settingsSwipeTimer = null;
      el.viewSettings.classList.remove("snap-back");
    }, reducedMotion() ? 0 : 260);
  }

  settingsSwipeCancel = () => {
    gesture = null;
    el.viewSettings.classList.remove("dragging");
  };
  el.viewSettings.addEventListener("touchend", () => finish(false));
  el.viewSettings.addEventListener("touchcancel", () => finish(true));
})();

// ===========================================================================
// 首次啟動導覽
// ===========================================================================

const ONBOARDING_COPY = {
  en: {
    guideTitle: "Setup guide", guideSubtitle: "Review the essentials for this device", language: "Language", appearance: "Appearance", back: "Back", skip: "Skip", next: "Continue", finish: "Start using Stepsemble",
    steps: [
      { eyebrow: "WELCOME", title: "Welcome aboard", body: "Stepsemble gives your local Pi Agent a calm, focused home on desktop and mobile.", points: ["Choose your language and appearance now; both can be changed later.", "Ink & Ivory is the default Stepsemble theme."] },
      { eyebrow: "LOCAL FIRST", title: "Your computer stays in charge", body: "Stepsemble is an interface for the Pi Agent installed on this computer. Sessions, credentials, and project files remain on the host.", points: ["Stepsemble listens on this computer and does not move your projects to a hosted cloud.", "Every additional computer needs its own Stepsemble installation."] },
      { eyebrow: "MAKE IT YOURS", title: "Models and projects", body: "Add a provider or sign in to an account from Settings, then choose a project folder to start a session.", points: ["Models & providers keeps services and model visibility in one place.", "New project can open your home folder or an allowed external drive."] },
      { eyebrow: "REMOTE ACCESS", title: "Connect securely", body: "For another computer or phone, keep the Node service on loopback and open Stepsemble through a private HTTPS address such as Tailscale Serve.", points: ["Use one-time pairing for an independent, revocable device credential; manual URL entry requires the same Web token.", "Never expose port 3140 directly to an untrusted network."] },
    ],
  },
  "zh-Hans": {
    guideTitle: "设置导览", guideSubtitle: "重新查看这台设备的基本设置", language: "语言", appearance: "外观", back: "返回", skip: "跳过", next: "继续", finish: "开始使用 Stepsemble",
    steps: [
      { eyebrow: "欢迎", title: "欢迎登船", body: "Stepsemble 为本机的 Pi Agent 提供一个简洁、专注，并同时适合电脑与手机的操作界面。", points: ["先选择语言与外观，之后仍可随时更改。", "Stepsemble 默认使用 Ink & Ivory 主题。"] },
      { eyebrow: "本机优先", title: "电脑仍是核心", body: "Stepsemble 是这台电脑上 Pi Agent 的操作界面。工作阶段、凭证与项目文件都会留在主机上。", points: ["Stepsemble 不会把你的项目搬到托管云端。", "每一台要使用的电脑都需要各自安装 Stepsemble。"] },
      { eyebrow: "开始配置", title: "模型与项目", body: "在设置中添加 Provider 或登录账号，然后选择项目文件夹来开始工作阶段。", points: ["“模型与 Provider”会集中管理服务与模型显示。", "“新建项目”可以打开主文件夹或允许访问的外接硬盘。"] },
      { eyebrow: "远程访问", title: "安全连接", body: "要从其他电脑或手机使用，请让 Node 服务只监听本机，并通过 Tailscale Serve 等私有 HTTPS 地址打开 Stepsemble。", points: ["使用一次性配对可取得独立且可撤销的设备凭证；手动输入网址仍要求两台电脑使用相同的 Web token。", "不要把 3140 端口直接开放到不受信任的网络。"] },
    ],
  },
  "zh-Hant": {
    guideTitle: "設定導覽", guideSubtitle: "重新查看這台裝置的基本設定", language: "語言", appearance: "外觀", back: "返回", skip: "略過", next: "繼續", finish: "開始使用 Stepsemble",
    steps: [
      { eyebrow: "歡迎", title: "歡迎登船", body: "Stepsemble 為本機的 Pi Agent 提供一個簡潔、專注，並同時適合電腦與手機的操作介面。", points: ["先選擇語言與外觀，之後仍可隨時更改。", "Stepsemble 預設使用 Ink & Ivory 主題。"] },
      { eyebrow: "本機優先", title: "電腦仍是核心", body: "Stepsemble 是這台電腦上 Pi Agent 的操作介面。工作階段、憑證與專案檔案都會留在主機上。", points: ["Stepsemble 不會把你的專案搬到託管雲端。", "每一台要使用的電腦都需要各自安裝 Stepsemble。"] },
      { eyebrow: "開始設定", title: "模型與專案", body: "在設定中加入 Provider 或登入帳號，然後選擇專案資料夾來開始工作階段。", points: ["「模型與 Provider」會集中管理服務與模型顯示。", "「新增專案」可以開啟家目錄或允許存取的外接硬碟。"] },
      { eyebrow: "遠端存取", title: "安全連線", body: "要從其他電腦或手機使用，請讓 Node 服務只監聽本機，並透過 Tailscale Serve 等私有 HTTPS 位址開啟 Stepsemble。", points: ["使用一次性配對可取得獨立且可撤銷的裝置憑證；手動輸入網址仍要求兩台電腦使用相同的 Web token。", "不要把 3140 port 直接開放到不受信任的網路。"] },
    ],
  },
  ja: {
    guideTitle: "セットアップガイド", guideSubtitle: "このデバイスの基本設定を確認", language: "言語", appearance: "外観", back: "戻る", skip: "スキップ", next: "次へ", finish: "Stepsemble を使い始める",
    steps: [
      { eyebrow: "ようこそ", title: "Stepsemble へようこそ", body: "Stepsemble は、このMac上の Pi Agent をデスクトップでもモバイルでも快適に操作できる、落ち着いたインターフェイスです。", points: ["言語と外観は後からいつでも変更できます。", "既定のテーマは Ink & Ivory です。"] },
      { eyebrow: "ローカル優先", title: "主役はこのコンピュータ", body: "Stepsemble はこのコンピュータにある Pi Agent の操作画面です。セッション、認証情報、プロジェクトファイルはホストに残ります。", points: ["プロジェクトを外部のホスティング環境へ移動しません。", "利用する各コンピュータに Stepsemble のインストールが必要です。"] },
      { eyebrow: "準備", title: "モデルとプロジェクト", body: "設定からプロバイダーを追加するかアカウントにサインインし、プロジェクトフォルダを選んでセッションを始めます。", points: ["モデルとプロバイダーは一つの画面で管理できます。", "新規プロジェクトからホームまたは許可済みの外部ドライブを開けます。"] },
      { eyebrow: "リモートアクセス", title: "安全に接続", body: "別のコンピュータやスマートフォンから使う場合は、Node サービスをループバックのままにし、Tailscale Serve などのプライベート HTTPS 経由で開きます。", points: ["ワンタイムペアリングでは独立して取り消せる認証情報が作成され、同じ Web トークンが必要なのは URL を手動入力する場合だけです。", "ポート 3140 を信頼できないネットワークへ直接公開しないでください。"] },
    ],
  },
  ko: {
    guideTitle: "설정 안내", guideSubtitle: "이 기기의 기본 설정 다시 보기", language: "언어", appearance: "화면 모드", back: "뒤로", skip: "건너뛰기", next: "계속", finish: "Stepsemble 시작하기",
    steps: [
      { eyebrow: "환영합니다", title: "Stepsemble에 오신 것을 환영합니다", body: "Stepsemble는 이 컴퓨터의 Pi Agent를 데스크톱과 모바일에서 편안하게 사용할 수 있는 깔끔한 인터페이스입니다.", points: ["언어와 화면 모드는 나중에도 언제든 바꿀 수 있습니다.", "기본 테마는 Ink & Ivory입니다."] },
      { eyebrow: "로컬 우선", title: "컴퓨터가 중심입니다", body: "Stepsemble는 이 컴퓨터에 설치된 Pi Agent의 인터페이스입니다. 세션, 자격 증명, 프로젝트 파일은 호스트에 남습니다.", points: ["프로젝트를 외부 호스팅 클라우드로 옮기지 않습니다.", "사용할 컴퓨터마다 Stepsemble를 설치해야 합니다."] },
      { eyebrow: "설정", title: "모델과 프로젝트", body: "설정에서 제공자를 추가하거나 계정에 로그인한 뒤 프로젝트 폴더를 선택해 세션을 시작하세요.", points: ["모델 및 제공자 화면에서 서비스와 모델 표시 여부를 함께 관리합니다.", "새 프로젝트에서 홈 폴더 또는 허용된 외장 드라이브를 열 수 있습니다."] },
      { eyebrow: "원격 접속", title: "안전하게 연결하세요", body: "다른 컴퓨터나 휴대폰에서 사용할 때는 Node 서비스를 로컬에만 두고 Tailscale Serve 같은 비공개 HTTPS 주소로 Stepsemble를 여세요.", points: ["일회용 페어링은 독립적으로 취소할 수 있는 인증 정보를 만들며, 같은 Web 토큰은 URL을 수동으로 입력할 때만 필요합니다.", "3140 포트를 신뢰할 수 없는 네트워크에 직접 공개하지 마세요."] },
    ],
  },
};

const ONBOARDING_LANGUAGE_LABELS = {
  en: ["English", "Chinese (Simplified)", "Chinese (Traditional)", "Japanese", "Korean", "Turkish", "French", "German", "Spanish", "Portuguese (Brazil)", "Italian"],
  "zh-Hans": ["英语", "简体中文", "繁体中文", "日语", "韩语", "土耳其语", "法语", "德语", "西班牙语", "葡萄牙语（巴西）", "意大利语"],
  "zh-Hant": ["英文", "簡體中文", "繁體中文", "日文", "韓文", "土耳其文", "法文", "德文", "西班牙文", "葡萄牙文（巴西）", "義大利文"],
  ja: ["英語", "簡体字中国語", "繁体字中国語", "日本語", "韓国語", "トルコ語", "フランス語", "ドイツ語", "スペイン語", "ポルトガル語（ブラジル）", "イタリア語"],
  ko: ["영어", "중국어 간체", "중국어 번체", "일본어", "한국어", "튀르키예어", "프랑스어", "독일어", "스페인어", "포르투갈어(브라질)", "이탈리아어"],
  tr: ["İngilizce", "Basitleştirilmiş Çince", "Geleneksel Çince", "Japonca", "Korece", "Türkçe", "Fransızca", "Almanca", "İspanyolca", "Brezilya Portekizcesi", "İtalyanca"],
  fr: ["Anglais", "Chinois simplifié", "Chinois traditionnel", "Japonais", "Coréen", "Turc", "Français", "Allemand", "Espagnol", "Portugais brésilien", "Italien"],
  de: ["Englisch", "Vereinfachtes Chinesisch", "Traditionelles Chinesisch", "Japanisch", "Koreanisch", "Türkisch", "Französisch", "Deutsch", "Spanisch", "Brasilianisches Portugiesisch", "Italienisch"],
  es: ["Inglés", "Chino simplificado", "Chino tradicional", "Japonés", "Coreano", "Turco", "Francés", "Alemán", "Español", "Portugués de Brasil", "Italiano"],
  "pt-BR": ["Inglês", "Chinês simplificado", "Chinês tradicional", "Japonês", "Coreano", "Turco", "Francês", "Alemão", "Espanhol", "Português do Brasil", "Italiano"],
  it: ["Inglese", "Cinese semplificato", "Cinese tradizionale", "Giapponese", "Coreano", "Turco", "Francese", "Tedesco", "Spagnolo", "Portoghese brasiliano", "Italiano"],
};

const ONBOARDING_EUROPEAN = {
  tr: ["Kurulum rehberi", "Bu cihazın temel ayarlarını yeniden gözden geçirin", "Dil", "Görünüm", "Geri", "Atla", "Devam", "Stepsemble'ı kullanmaya başla", [
    ["HOŞ GELDİNİZ", "Stepsemble'a hoş geldiniz", "Stepsemble, bu bilgisayardaki Pi Agent için masaüstü ve mobilde sade, odaklı bir arayüz sunar.", "Dil ve görünümü daha sonra değiştirebilirsiniz.", "Varsayılan tema Ink & Ivory'dir."],
    ["ÖNCE YEREL", "Kontrol bilgisayarınızda", "Stepsemble bu bilgisayardaki Pi Agent'ın arayüzüdür. Oturumlar, kimlik bilgileri ve proje dosyaları ana bilgisayarda kalır.", "Projeleriniz barındırılan bir buluta taşınmaz.", "Kullanacağınız her bilgisayara Stepsemble kurulmalıdır."],
    ["HAZIRLIK", "Modeller ve projeler", "Ayarlar'dan bir sağlayıcı ekleyin veya oturum açın; ardından bir proje klasörü seçerek oturum başlatın.", "Modeller ve sağlayıcılar tek yerde yönetilir.", "Yeni proje, ana klasörü veya izin verilen harici diski açabilir."],
    ["UZAKTAN ERİŞİM", "Güvenli bağlanın", "Başka bir bilgisayar veya telefondan kullanmak için Node hizmetini yerel döngüde tutun ve Stepsemble'ı Tailscale Serve gibi özel bir HTTPS adresiyle açın.", "Tek kullanımlık eşleştirme bağımsız ve iptal edilebilir bir kimlik bilgisi oluşturur; aynı Web token'ı yalnızca URL elle girildiğinde gerekir.", "3140 numaralı bağlantı noktasını güvenilmeyen bir ağa doğrudan açmayın."],
  ]],
  fr: ["Guide de configuration", "Revoir les réglages essentiels de cet appareil", "Langue", "Apparence", "Retour", "Ignorer", "Continuer", "Commencer avec Stepsemble", [
    ["BIENVENUE", "Bienvenue à bord", "Stepsemble offre à l’agent Pi de cet ordinateur une interface claire et sereine, sur ordinateur comme sur mobile.", "Vous pourrez modifier la langue et l’apparence à tout moment.", "Ink & Ivory est le thème par défaut."],
    ["LOCAL D’ABORD", "Votre ordinateur garde le contrôle", "Stepsemble est l’interface de l’agent Pi installé sur cet ordinateur. Les sessions, identifiants et fichiers de projet restent sur l’hôte.", "Vos projets ne sont pas déplacés vers un cloud hébergé.", "Chaque ordinateur utilisé doit avoir sa propre installation de Stepsemble."],
    ["CONFIGURATION", "Modèles et projets", "Ajoutez un fournisseur ou connectez un compte dans Réglages, puis choisissez un dossier de projet pour démarrer une session.", "Modèles et fournisseurs sont gérés au même endroit.", "Nouveau projet peut ouvrir votre dossier personnel ou un disque externe autorisé."],
    ["ACCÈS À DISTANCE", "Connectez-vous en toute sécurité", "Depuis un autre ordinateur ou téléphone, laissez le service Node sur l’interface locale et ouvrez Stepsemble via une adresse HTTPS privée, telle que Tailscale Serve.", "L’association à usage unique crée un identifiant indépendant et révocable ; le même jeton Web n’est requis que pour la saisie manuelle d’une URL.", "N’exposez jamais directement le port 3140 à un réseau non fiable."],
  ]],
  de: ["Einrichtungsassistent", "Grundeinstellungen dieses Geräts erneut ansehen", "Sprache", "Darstellung", "Zurück", "Überspringen", "Weiter", "Stepsemble verwenden", [
    ["WILLKOMMEN", "Willkommen an Bord", "Stepsemble gibt dem Pi Agent auf diesem Computer eine ruhige, übersichtliche Oberfläche für Desktop und Mobilgeräte.", "Sprache und Darstellung lassen sich später jederzeit ändern.", "Ink & Ivory ist das Standarddesign."],
    ["LOKAL ZUERST", "Ihr Computer behält die Kontrolle", "Stepsemble ist die Oberfläche für den Pi Agent auf diesem Computer. Sitzungen, Zugangsdaten und Projektdateien bleiben auf dem Host.", "Ihre Projekte werden nicht in eine gehostete Cloud verschoben.", "Auf jedem verwendeten Computer muss Stepsemble installiert sein."],
    ["EINRICHTUNG", "Modelle und Projekte", "Fügen Sie unter Einstellungen einen Anbieter hinzu oder melden Sie sich an. Wählen Sie danach einen Projektordner für die erste Sitzung.", "Modelle und Anbieter werden an einer Stelle verwaltet.", "Neues Projekt kann den Benutzerordner oder ein freigegebenes externes Laufwerk öffnen."],
    ["FERNZUGRIFF", "Sicher verbinden", "Für den Zugriff von einem anderen Computer oder Smartphone bleibt der Node-Dienst lokal gebunden. Öffnen Sie Stepsemble über eine private HTTPS-Adresse wie Tailscale Serve.", "Die einmalige Kopplung erstellt eine unabhängige, widerrufbare Anmeldung; dasselbe Web-Token ist nur bei manueller URL-Eingabe erforderlich.", "Geben Sie Port 3140 nie direkt in einem nicht vertrauenswürdigen Netzwerk frei."],
  ]],
  es: ["Guía de configuración", "Repasa los ajustes esenciales de este dispositivo", "Idioma", "Apariencia", "Atrás", "Omitir", "Continuar", "Empezar a usar Stepsemble", [
    ["BIENVENIDA", "Bienvenido a bordo", "Stepsemble ofrece al agente Pi de este ordenador una interfaz tranquila y clara tanto en el escritorio como en el móvil.", "Puedes cambiar el idioma y la apariencia en cualquier momento.", "Ink & Ivory es el tema predeterminado."],
    ["PRIMERO, LOCAL", "Tu ordenador mantiene el control", "Stepsemble es la interfaz del agente Pi instalado en este ordenador. Las sesiones, credenciales y archivos de proyecto permanecen en el equipo anfitrión.", "Tus proyectos no se trasladan a una nube alojada.", "Cada ordenador que uses necesita su propia instalación de Stepsemble."],
    ["CONFIGURACIÓN", "Modelos y proyectos", "Añade un proveedor o inicia sesión desde Ajustes y elige una carpeta de proyecto para comenzar una sesión.", "Los modelos y proveedores se administran en un mismo lugar.", "Nuevo proyecto puede abrir tu carpeta personal o una unidad externa autorizada."],
    ["ACCESO REMOTO", "Conéctate de forma segura", "Para usar otro ordenador o teléfono, mantén el servicio Node en la interfaz local y abre Stepsemble mediante una dirección HTTPS privada, como Tailscale Serve.", "El emparejamiento de un solo uso crea una credencial independiente y revocable; el mismo token web solo es necesario al introducir la URL manualmente.", "No expongas el puerto 3140 directamente a una red que no sea de confianza."],
  ]],
  "pt-BR": ["Guia de configuração", "Revise as configurações essenciais deste dispositivo", "Idioma", "Aparência", "Voltar", "Pular", "Continuar", "Começar a usar o Stepsemble", [
    ["BOAS-VINDAS", "Bem-vindo a bordo", "O Stepsemble oferece ao Pi Agent deste computador uma interface limpa e tranquila no desktop e no celular.", "Idioma e aparência podem ser alterados a qualquer momento.", "Ink & Ivory é o tema padrão."],
    ["LOCAL PRIMEIRO", "Seu computador continua no controle", "O Stepsemble é a interface do Pi Agent instalado neste computador. Sessões, credenciais e arquivos de projeto permanecem no host.", "Seus projetos não são enviados para uma nuvem hospedada.", "Cada computador usado precisa da própria instalação do Stepsemble."],
    ["CONFIGURAÇÃO", "Modelos e projetos", "Adicione um provedor ou entre em uma conta nos Ajustes e escolha uma pasta de projeto para iniciar uma sessão.", "Modelos e provedores ficam reunidos em um só lugar.", "Novo projeto pode abrir sua pasta pessoal ou uma unidade externa permitida."],
    ["ACESSO REMOTO", "Conecte-se com segurança", "Em outro computador ou celular, mantenha o serviço Node restrito ao endereço local e abra o Stepsemble por um endereço HTTPS privado, como o Tailscale Serve.", "O pareamento de uso único cria uma credencial independente e revogável; o mesmo token Web só é necessário ao informar a URL manualmente.", "Não exponha a porta 3140 diretamente a uma rede não confiável."],
  ]],
  it: ["Guida alla configurazione", "Rivedi le impostazioni essenziali di questo dispositivo", "Lingua", "Aspetto", "Indietro", "Salta", "Continua", "Inizia a usare Stepsemble", [
    ["BENVENUTO", "Benvenuto a bordo", "Stepsemble offre al Pi Agent di questo computer un’interfaccia ordinata e tranquilla, sia su desktop sia su dispositivi mobili.", "Lingua e aspetto possono essere modificati in qualsiasi momento.", "Ink & Ivory è il tema predefinito."],
    ["PRIMA IL LOCALE", "Il computer mantiene il controllo", "Stepsemble è l’interfaccia del Pi Agent installato su questo computer. Sessioni, credenziali e file di progetto restano sull’host.", "I progetti non vengono trasferiti in un cloud ospitato.", "Ogni computer utilizzato deve avere la propria installazione di Stepsemble."],
    ["CONFIGURAZIONE", "Modelli e progetti", "Aggiungi un provider o accedi a un account dalle Impostazioni, poi scegli una cartella di progetto per avviare una sessione.", "Modelli e provider vengono gestiti in un unico punto.", "Nuovo progetto può aprire la cartella personale o un’unità esterna autorizzata."],
    ["ACCESSO REMOTO", "Connettiti in sicurezza", "Da un altro computer o telefono, mantieni il servizio Node sull’interfaccia locale e apri Stepsemble tramite un indirizzo HTTPS privato, come Tailscale Serve.", "L’abbinamento una tantum crea una credenziale indipendente e revocabile; lo stesso token Web serve solo quando inserisci manualmente l’URL.", "Non esporre direttamente la porta 3140 a una rete non attendibile."],
  ]],
};

for (const [locale, values] of Object.entries(ONBOARDING_EUROPEAN)) {
  const [guideTitle, guideSubtitle, language, appearance, back, skip, next, finish, rawSteps] = values;
  ONBOARDING_COPY[locale] = { guideTitle, guideSubtitle, language, appearance, back, skip, next, finish, steps: rawSteps.map(([eyebrow, title, body, first, second]) => ({ eyebrow, title, body, points: [first, second] })) };
}

// Keep the first-run path actionable rather than assuming that a new user
// already knows where the token, device controls, or provider settings live.
// This is rendered directly (not through the DOM translator), so every
// supported locale has its complete five-step copy here.
const ONBOARDING_ACTIONABLE_STEPS = {
  en: [
    { eyebrow: "WELCOME", title: "Welcome aboard", body: "Stepsemble keeps the Pi Agent, sessions, credentials, and projects on the selected computer.", points: ["Choose your language and appearance now; both can be changed later."] },
    { eyebrow: "TOKEN & SIGN-IN", title: "Find your Web token", body: "The installer creates a private Web token on the computer running Stepsemble. On that computer, open Terminal and run cat ~/.config/stepsemble/token, then paste it here. From another device, retrieve it securely from that host.", points: ["Never share the token in chat, screenshots, repositories, or logs.", "If STEPSEMBLE_TOKEN_FILE is configured, use that file instead of the default path."] },
    { eyebrow: "DEVICES", title: "Connect another computer", body: "Install and run Stepsemble on each additional computer. Use Tailscale or HTTPS, then open Settings → Devices → Add device, or use a five-minute pairing code.", points: ["Prefer one-time pairing for an independent, revocable credential; only manual URL entry requires the same Web token.", "Never expose public port 3140 to an untrusted network."] },
    { eyebrow: "MODELS & PROVIDERS", title: "Add an LLM provider", body: "Open Settings → Connection → Models & providers. Choose a catalog service, account/OAuth sign-in, API key, local service, or Custom provider.", points: ["Credentials stay on the selected host.", "Then select the visible models you want to use."] },
    { eyebrow: "PROJECT", title: "Choose a folder and start", body: "Open New project, choose a folder on this host, optionally name the session, and select Start here.", points: ["The folder picker starts at the host home and only shows allowed browse roots.", "You can return to this guide from Settings → About → Setup guide."] },
  ],
  "zh-Hans": [
    { eyebrow: "欢迎", title: "欢迎使用", body: "Stepsemble 会将 Pi Agent、会话、凭证和项目保留在选定的电脑上。", points: ["现在选择语言和外观，之后都可以更改。"] },
    { eyebrow: "TOKEN 与登录", title: "找到 Web token", body: "安装程序会在运行 Stepsemble 的电脑上创建私密 Web token。在那台电脑打开终端并运行 cat ~/.config/stepsemble/token，然后将结果粘贴到这里。在其他设备上，请从该主机安全地取得 token。", points: ["绝不要在聊天、截图、代码仓库或日志中分享 token。", "如果配置了 STEPSEMBLE_TOKEN_FILE，请使用该文件，而不是默认路径。"] },
    { eyebrow: "设备", title: "连接另一台电脑", body: "在每台额外的电脑上安装并运行 Stepsemble。使用 Tailscale 或 HTTPS，然后打开“设置 → 设备 → 添加设备”，也可以使用五分钟有效的一次性配对码。", points: ["优先使用一次性配对来取得独立且可撤销的凭证；只有手动输入网址时才需要相同的 Web token。", "不要将公共 3140 端口暴露给不受信任的网络。"] },
    { eyebrow: "模型与服务", title: "添加 LLM 服务商", body: "打开“设置 → 连接 → 模型与 Provider”。选择目录服务、账号/OAuth 登录、API key、本地服务或自定义 Provider。", points: ["凭证保留在选定的主机上。", "然后选择要使用的可见模型。"] },
    { eyebrow: "项目", title: "选择文件夹并开始", body: "打开“新建项目”，选择这台主机上的文件夹，可选填写会话名称，然后选择“从这里开始”。", points: ["文件夹选择器从主机主目录开始，只显示允许访问的目录。", "以后可以从“设置 → 关于 → 设置导览”再次打开本指南。"] },
  ],
  "zh-Hant": [
    { eyebrow: "歡迎", title: "歡迎使用", body: "Stepsemble 會將 Pi Agent、工作階段、憑證與專案保留在選定的電腦上。", points: ["現在選擇語言與外觀，之後都可以更改。"] },
    { eyebrow: "TOKEN 與登入", title: "找到 Web token", body: "安裝程式會在執行 Stepsemble 的電腦上建立私密 Web token。在該電腦開啟終端機並執行 cat ~/.config/stepsemble/token，然後將結果貼到這裡。在其他裝置上，請從該主機安全地取得 token。", points: ["絕不要在聊天、截圖、程式碼儲存庫或日誌中分享 token。", "如果設定了 STEPSEMBLE_TOKEN_FILE，請使用該檔案，不要使用預設路徑。"] },
    { eyebrow: "裝置", title: "連接另一台電腦", body: "在每台額外的電腦上安裝並執行 Stepsemble。使用 Tailscale 或 HTTPS，然後開啟「設定 → 設備 → 新增設備」，也可以使用五分鐘有效的一次性配對碼。", points: ["優先使用一次性配對來取得獨立且可撤銷的憑證；只有手動輸入網址時才需要相同的 Web token。", "不要將公開的 3140 port 暴露給不受信任的網路。"] },
    { eyebrow: "模型與服務", title: "加入 LLM 服務商", body: "開啟「設定 → 連線 → 模型與 Provider」。選擇目錄服務、帳號／OAuth 登入、API key、本機服務或自訂 Provider。", points: ["憑證會保留在選定的主機上。", "然後選擇要使用的可見模型。"] },
    { eyebrow: "專案", title: "選擇資料夾並開始", body: "開啟「新增專案」，選擇這台主機上的資料夾，可選填寫工作階段名稱，然後選擇「在這裡開始」。", points: ["資料夾選擇器會從主機家目錄開始，只顯示允許存取的目錄。", "之後可以從「設定 → 關於 → 設定導覽」再次開啟本指南。"] },
  ],
  ja: [
    { eyebrow: "ようこそ", title: "Stepsemble へようこそ", body: "Stepsemble は Pi Agent、セッション、認証情報、プロジェクトを選択したコンピューターに保管します。", points: ["言語と外観は今選択でき、後から変更できます。"] },
    { eyebrow: "トークンとサインイン", title: "Web トークンを確認", body: "インストーラーは Stepsemble を実行するコンピューターに非公開の Web トークンを作成します。そのコンピューターでターミナルを開き、cat ~/.config/stepsemble/token を実行して、結果をここに貼り付けます。別のデバイスでは、そのホストから安全にトークンを取得してください。", points: ["トークンをチャット、スクリーンショット、リポジトリ、ログで共有しないでください。", "カスタムの STEPSEMBLE_TOKEN_FILE を設定している場合は、既定のパスではなくそのファイルを使います。"] },
    { eyebrow: "デバイス", title: "別のコンピューターを接続", body: "追加する各コンピューターに Stepsemble をインストールして実行します。Tailscale または HTTPS を使い、「設定 → デバイス → デバイスを追加」を開くか、5 分間有効なペアリングコードを使います。", points: ["独立して取り消せる認証情報にはワンタイムペアリングを使います。同じ Web トークンが必要なのは URL を手動入力する場合だけです。", "公開ポート 3140 を信頼できないネットワークに公開しないでください。"] },
    { eyebrow: "モデルとプロバイダー", title: "LLM プロバイダーを追加", body: "「設定 → 接続 → モデルとプロバイダー」を開きます。カタログサービス、アカウント／OAuth サインイン、API キー、ローカルサービス、またはカスタムプロバイダーを選択します。", points: ["認証情報は選択したホストに保管されます。", "次に使用するモデルを表示対象から選択します。"] },
    { eyebrow: "プロジェクト", title: "フォルダーを選んで開始", body: "「新しいプロジェクト」を開き、このホストのフォルダーを選び、必要ならセッション名を入力して「ここから開始」を選択します。", points: ["フォルダー選択はホストのホームから始まり、許可されたルートだけを表示します。", "後で「設定 → 概要 → セットアップガイド」から再び開けます。"] },
  ],
  ko: [
    { eyebrow: "환영합니다", title: "Stepsemble에 오신 것을 환영합니다", body: "Stepsemble는 Pi Agent, 세션, 자격 증명과 프로젝트를 선택한 컴퓨터에 보관합니다.", points: ["지금 언어와 화면 모드를 선택할 수 있으며 나중에 변경할 수 있습니다."] },
    { eyebrow: "토큰 및 로그인", title: "Web 토큰 찾기", body: "설치 프로그램이 Stepsemble를 실행하는 컴퓨터에 비공개 Web 토큰을 만듭니다. 해당 컴퓨터에서 터미널을 열고 cat ~/.config/stepsemble/token을 실행한 뒤 결과를 여기에 붙여넣으세요. 다른 기기에서는 해당 호스트에서 토큰을 안전하게 가져오세요.", points: ["토큰을 채팅, 스크린샷, 저장소 또는 로그에 절대 공유하지 마세요.", "사용자 지정 STEPSEMBLE_TOKEN_FILE을 설정했다면 기본 경로 대신 해당 파일을 사용하세요."] },
    { eyebrow: "기기", title: "다른 컴퓨터 연결", body: "추가할 각 컴퓨터에 Stepsemble를 설치하고 실행하세요. Tailscale 또는 HTTPS를 사용한 뒤 ‘설정 → 기기 → 기기 추가’를 열거나 5분 동안 유효한 페어링 코드를 사용하세요.", points: ["독립적으로 취소할 수 있는 인증 정보에는 일회용 페어링을 사용하세요. 같은 Web 토큰은 URL을 수동으로 입력할 때만 필요합니다.", "공개 포트 3140을 신뢰할 수 없는 네트워크에 노출하지 마세요."] },
    { eyebrow: "모델 및 제공자", title: "LLM 제공자 추가", body: "‘설정 → 연결 → 모델 및 제공자’를 여세요. 카탈로그 서비스, 계정/OAuth 로그인, API 키, 로컬 서비스 또는 사용자 지정 제공자를 선택하세요.", points: ["인증 정보는 선택한 호스트에만 저장됩니다.", "그런 다음 사용할 모델을 표시 목록에서 선택하세요."] },
    { eyebrow: "프로젝트", title: "폴더를 선택하고 시작", body: "‘새 프로젝트’를 열고 이 호스트의 폴더를 선택한 다음 세션 이름을 입력하고 ‘여기서 시작’을 누르세요.", points: ["폴더 선택기는 호스트 홈에서 시작하며 허용된 경로만 보여 줍니다.", "나중에 ‘설정 → 정보 → 설정 안내’에서 이 안내를 다시 열 수 있습니다."] },
  ],
  tr: [
    { eyebrow: "HOŞ GELDİNİZ", title: "Stepsemble'a hoş geldiniz", body: "Stepsemble; Pi Agent'ı, oturumları, kimlik bilgilerini ve projeleri seçtiğiniz bilgisayarda tutar.", points: ["Dil ve görünümü şimdi seçebilirsiniz; daha sonra da değiştirebilirsiniz."] },
    { eyebrow: "TOKEN VE GİRİŞ", title: "Web token'ını bulun", body: "Yükleyici, Stepsemble'ı çalıştıran bilgisayarda özel bir Web token'ı oluşturur. Bu bilgisayarda Terminal'i açıp cat ~/.config/stepsemble/token komutunu çalıştırın ve sonucu buraya yapıştırın. Başka bir cihazda token'ı bu ana bilgisayardan güvenli şekilde alın.", points: ["Token'ı sohbetlerde, ekran görüntülerinde, depolarda veya günlüklerde asla paylaşmayın.", "Özel bir STEPSEMBLE_TOKEN_FILE yapılandırıldıysa varsayılan yol yerine bu dosyayı kullanın."] },
    { eyebrow: "CİHAZLAR", title: "Başka bir bilgisayarı bağlayın", body: "Eklediğiniz her bilgisayara Stepsemble'i yükleyip çalıştırın. Tailscale veya HTTPS kullanın; ardından Ayarlar → Cihazlar → Cihaz ekle yolunu açın ya da beş dakika geçerli bir eşleştirme kodu kullanın.", points: ["Bağımsız ve iptal edilebilir kimlik bilgisi için tek kullanımlık eşleştirmeyi tercih edin; aynı Web token'ı yalnızca URL elle girildiğinde gerekir.", "3140 numaralı genel bağlantı noktasını güvenilmeyen bir ağa açmayın."] },
    { eyebrow: "MODELLER VE SAĞLAYICILAR", title: "Bir LLM sağlayıcısı ekleyin", body: "Ayarlar → Bağlantı → Modeller ve sağlayıcılar bölümünü açın. Bir katalog hizmeti, hesap/OAuth girişi, API anahtarı, yerel hizmet veya Özel sağlayıcı seçin.", points: ["Kimlik bilgileri seçilen ana bilgisayarda kalır.", "Ardından kullanmak istediğiniz görünür modelleri seçin."] },
    { eyebrow: "PROJE", title: "Klasör seçip başlayın", body: "Yeni proje'yi açın, bu ana bilgisayardaki bir klasörü seçin, isteğe bağlı oturum adını yazın ve Buradan başla'yı seçin.", points: ["Klasör seçici ana bilgisayarın ana klasöründe başlar ve yalnızca izin verilen kökleri gösterir.", "Bu rehberi daha sonra Ayarlar → Hakkında → Kurulum rehberi bölümünden açabilirsiniz."] },
  ],
  fr: [
    { eyebrow: "BIENVENUE", title: "Bienvenue sur Stepsemble", body: "Stepsemble conserve l’agent Pi, les sessions, les identifiants et les projets sur l’ordinateur sélectionné.", points: ["Choisissez la langue et l’apparence maintenant ; vous pourrez les modifier plus tard."] },
    { eyebrow: "JETON ET CONNEXION", title: "Trouver votre jeton Web", body: "L’installeur crée un jeton Web privé sur l’ordinateur qui exécute Stepsemble. Sur cet ordinateur, ouvrez le Terminal et exécutez cat ~/.config/stepsemble/token, puis collez le résultat ici. Depuis un autre appareil, récupérez le jeton en toute sécurité sur cet hôte.", points: ["Ne partagez jamais le jeton dans un chat, une capture d’écran, un dépôt ou un journal.", "Si un STEPSEMBLE_TOKEN_FILE personnalisé est configuré, utilisez ce fichier plutôt que le chemin par défaut."] },
    { eyebrow: "APPAREILS", title: "Connecter un autre ordinateur", body: "Installez et lancez Stepsemble sur chaque ordinateur supplémentaire. Utilisez Tailscale ou HTTPS, puis ouvrez Réglages → Appareils → Ajouter un appareil, ou utilisez un code d’association valable cinq minutes.", points: ["Préférez l’association à usage unique pour un identifiant indépendant et révocable ; le même jeton Web n’est requis que pour la saisie manuelle d’une URL.", "N’exposez jamais le port public 3140 à un réseau non fiable."] },
    { eyebrow: "MODÈLES ET FOURNISSEURS", title: "Ajouter un fournisseur LLM", body: "Ouvrez Réglages → Connexion → Modèles et fournisseurs. Choisissez un service du catalogue, une connexion par compte/OAuth, une clé API, un service local ou un fournisseur personnalisé.", points: ["Les identifiants restent sur l’hôte sélectionné.", "Sélectionnez ensuite les modèles visibles que vous souhaitez utiliser."] },
    { eyebrow: "PROJET", title: "Choisir un dossier et commencer", body: "Ouvrez Nouveau projet, choisissez un dossier sur cet hôte, indiquez éventuellement le nom de la session, puis sélectionnez Commencer ici.", points: ["Le sélecteur commence dans le dossier personnel de l’hôte et n’affiche que les racines autorisées.", "Vous pourrez rouvrir ce guide dans Réglages → À propos → Guide de configuration."] },
  ],
  de: [
    { eyebrow: "WILLKOMMEN", title: "Willkommen bei Stepsemble", body: "Stepsemble bewahrt Pi Agent, Sitzungen, Zugangsdaten und Projekte auf dem ausgewählten Computer auf.", points: ["Wählen Sie Sprache und Darstellung jetzt aus; beides lässt sich später ändern."] },
    { eyebrow: "TOKEN UND ANMELDUNG", title: "Web-Token finden", body: "Das Installationsprogramm erstellt ein privates Web-Token auf dem Computer, auf dem Stepsemble läuft. Öffnen Sie dort das Terminal und führen Sie cat ~/.config/stepsemble/token aus. Fügen Sie das Ergebnis hier ein. Rufen Sie das Token auf einem anderen Gerät sicher von diesem Host ab.", points: ["Teilen Sie das Token niemals in Chats, Screenshots, Repositories oder Protokollen.", "Wenn ein eigenes STEPSEMBLE_TOKEN_FILE konfiguriert ist, verwenden Sie diese Datei statt des Standardpfads."] },
    { eyebrow: "GERÄTE", title: "Anderen Computer verbinden", body: "Installieren und starten Sie Stepsemble auf jedem weiteren Computer. Verwenden Sie Tailscale oder HTTPS und öffnen Sie Einstellungen → Geräte → Gerät hinzufügen oder verwenden Sie einen fünf Minuten gültigen Kopplungscode.", points: ["Bevorzugen Sie die einmalige Kopplung für eine unabhängige, widerrufbare Anmeldung; dasselbe Web-Token ist nur bei manueller URL-Eingabe erforderlich.", "Geben Sie den öffentlichen Port 3140 nie in einem nicht vertrauenswürdigen Netzwerk frei."] },
    { eyebrow: "MODELLE UND ANBIETER", title: "LLM-Anbieter hinzufügen", body: "Öffnen Sie Einstellungen → Verbindung → Modelle und Anbieter. Wählen Sie einen Katalogdienst, die Konto-/OAuth-Anmeldung, einen API-Schlüssel, einen lokalen Dienst oder einen benutzerdefinierten Anbieter.", points: ["Zugangsdaten bleiben auf dem ausgewählten Host.", "Wählen Sie danach die sichtbaren Modelle aus, die Sie verwenden möchten."] },
    { eyebrow: "PROJEKT", title: "Ordner auswählen und starten", body: "Öffnen Sie Neues Projekt, wählen Sie einen Ordner auf diesem Host, geben Sie optional einen Sitzungsnamen ein und wählen Sie Hier starten.", points: ["Die Ordnerauswahl beginnt im Home-Ordner des Hosts und zeigt nur erlaubte Wurzeln.", "Sie können den Assistenten später unter Einstellungen → Über → Einrichtungsassistent erneut öffnen."] },
  ],
  es: [
    { eyebrow: "BIENVENIDA", title: "Bienvenido a Stepsemble", body: "Stepsemble conserva el agente Pi, las sesiones, las credenciales y los proyectos en el ordenador seleccionado.", points: ["Elige ahora el idioma y la apariencia; podrás cambiarlos más adelante."] },
    { eyebrow: "TOKEN E INICIO DE SESIÓN", title: "Encuentra tu token web", body: "El instalador crea un token web privado en el ordenador que ejecuta Stepsemble. En ese ordenador, abre Terminal y ejecuta cat ~/.config/stepsemble/token; después pega el resultado aquí. Desde otro dispositivo, recupera el token de forma segura en ese equipo anfitrión.", points: ["Nunca compartas el token en chats, capturas de pantalla, repositorios ni registros.", "Si se ha configurado un STEPSEMBLE_TOKEN_FILE personalizado, usa ese archivo en lugar de la ruta predeterminada."] },
    { eyebrow: "DISPOSITIVOS", title: "Conecta otro ordenador", body: "Instala y ejecuta Stepsemble en cada ordenador adicional. Usa Tailscale o HTTPS y abre Ajustes → Dispositivos → Añadir dispositivo, o utiliza un código de emparejamiento válido durante cinco minutos.", points: ["Prefiere el emparejamiento de un solo uso para obtener una credencial independiente y revocable; el mismo token web solo se necesita al introducir la URL manualmente.", "No expongas el puerto público 3140 directamente a una red que no sea de confianza."] },
    { eyebrow: "MODELOS Y PROVEEDORES", title: "Añade un proveedor LLM", body: "Abre Ajustes → Conexión → Modelos y proveedores. Elige un servicio del catálogo, inicio de sesión con cuenta/OAuth, una clave API, un servicio local o un proveedor personalizado.", points: ["Las credenciales permanecen en el equipo anfitrión seleccionado.", "Después, selecciona los modelos visibles que quieras utilizar."] },
    { eyebrow: "PROYECTO", title: "Elige una carpeta y empieza", body: "Abre Nuevo proyecto, elige una carpeta en este equipo anfitrión, escribe opcionalmente el nombre de la sesión y selecciona Empezar aquí.", points: ["El selector empieza en la carpeta personal del equipo y solo muestra raíces permitidas.", "Puedes volver a abrir esta guía desde Ajustes → Acerca de → Guía de configuración."] },
  ],
  "pt-BR": [
    { eyebrow: "BOAS-VINDAS", title: "Bem-vindo ao Stepsemble", body: "O Stepsemble mantém o Pi Agent, as sessões, as credenciais e os projetos no computador selecionado.", points: ["Escolha o idioma e a aparência agora; ambos podem ser alterados depois."] },
    { eyebrow: "TOKEN E LOGIN", title: "Encontre seu token Web", body: "O instalador cria um token Web privado no computador que executa o Stepsemble. Nesse computador, abra o Terminal e execute cat ~/.config/stepsemble/token; depois cole o resultado aqui. Em outro dispositivo, obtenha o token com segurança nesse host.", points: ["Nunca compartilhe o token em chats, capturas de tela, repositórios ou logs.", "Se um STEPSEMBLE_TOKEN_FILE personalizado estiver configurado, use esse arquivo em vez do caminho padrão."] },
    { eyebrow: "DISPOSITIVOS", title: "Conecte outro computador", body: "Instale e execute o Stepsemble em cada computador adicional. Use Tailscale ou HTTPS e abra Configurações → Dispositivos → Adicionar dispositivo, ou use um código de pareamento válido por cinco minutos.", points: ["Prefira o pareamento de uso único para obter uma credencial independente e revogável; o mesmo token Web só é necessário ao informar a URL manualmente.", "Não exponha a porta pública 3140 diretamente a uma rede não confiável."] },
    { eyebrow: "MODELOS E PROVEDORES", title: "Adicione um provedor de LLM", body: "Abra Configurações → Conexão → Modelos e provedores. Escolha um serviço do catálogo, login com conta/OAuth, uma chave de API, um serviço local ou um provedor personalizado.", points: ["As credenciais permanecem no host selecionado.", "Depois, selecione os modelos visíveis que deseja usar."] },
    { eyebrow: "PROJETO", title: "Escolha uma pasta e comece", body: "Abra Novo projeto, escolha uma pasta neste host, informe opcionalmente o nome da sessão e selecione Começar aqui.", points: ["O seletor começa na pasta pessoal do host e mostra apenas raízes permitidas.", "Você pode reabrir este guia em Configurações → Sobre → Guia de configuração."] },
  ],
  it: [
    { eyebrow: "BENVENUTO", title: "Benvenuto in Stepsemble", body: "Stepsemble conserva Pi Agent, sessioni, credenziali e progetti sul computer selezionato.", points: ["Scegli ora lingua e aspetto; potrai modificarli in seguito."] },
    { eyebrow: "TOKEN E ACCESSO", title: "Trova il token Web", body: "Il programma di installazione crea un token Web privato sul computer che esegue Stepsemble. Su quel computer apri Terminale ed esegui cat ~/.config/stepsemble/token, quindi incolla il risultato qui. Da un altro dispositivo, recupera il token in modo sicuro da quell’host.", points: ["Non condividere mai il token in chat, schermate, repository o log.", "Se è configurato un STEPSEMBLE_TOKEN_FILE personalizzato, usa quel file invece del percorso predefinito."] },
    { eyebrow: "DISPOSITIVI", title: "Collega un altro computer", body: "Installa e avvia Stepsemble su ogni computer aggiuntivo. Usa Tailscale o HTTPS, quindi apri Impostazioni → Dispositivi → Aggiungi dispositivo oppure usa un codice di abbinamento valido cinque minuti.", points: ["Preferisci l’abbinamento una tantum per una credenziale indipendente e revocabile; lo stesso token Web serve solo quando inserisci manualmente l’URL.", "Non esporre la porta pubblica 3140 a una rete non attendibile."] },
    { eyebrow: "MODELLI E PROVIDER", title: "Aggiungi un provider LLM", body: "Apri Impostazioni → Connessione → Modelli e provider. Scegli un servizio del catalogo, l’accesso con account/OAuth, una chiave API, un servizio locale o un provider personalizzato.", points: ["Le credenziali restano sull’host selezionato.", "Poi seleziona i modelli visibili che vuoi usare."] },
    { eyebrow: "PROGETTO", title: "Scegli una cartella e inizia", body: "Apri Nuovo progetto, scegli una cartella su questo host, inserisci facoltativamente il nome della sessione e seleziona Inizia qui.", points: ["Il selettore parte dalla cartella home dell’host e mostra solo le radici autorizzate.", "Puoi riaprire questa guida da Impostazioni → Informazioni → Guida alla configurazione."] },
  ],
};
for (const [locale, steps] of Object.entries(ONBOARDING_ACTIONABLE_STEPS)) {
  if (ONBOARDING_COPY[locale]) ONBOARDING_COPY[locale].steps = steps;
}

// Gesture guidance belongs in the setup guide, not in a permanent Settings row.
// Keep it localized here because onboarding copy is intentionally rendered
// outside the generic DOM translator.
const ONBOARDING_GESTURE_TIPS = {
  en: "Pull down to refresh; swipe from the left edge in a conversation or Settings to go back; long-press a session to rename or delete",
  "zh-Hans": "下拉刷新；在对话或设置中从左侧边缘向右滑返回；长按会话可重命名或删除。",
  "zh-Hant": "下拉重新整理；在對話或設定中從左側邊緣向右滑可返回；長按工作階段可重新命名或刪除。",
  ja: "下に引いて更新、会話または設定で左端からスワイプして戻り、セッションを長押しして名前変更や削除ができます。",
  ko: "세션 목록을 아래로 당겨 새로 고치고, 대화나 설정에서는 왼쪽 가장자리에서 밀어 뒤로 가며, 세션을 길게 눌러 이름을 바꾸거나 삭제할 수 있습니다.",
  tr: "Yenilemek için aşağı çekin; konuşma veya Ayarlar'dan geri dönmek için sol kenardan kaydırın; bir oturumu yeniden adlandırmak veya silmek için uzun basın.",
  fr: "Tirez vers le bas pour actualiser ; dans une conversation ou les réglages, balayez depuis le bord gauche pour revenir ; appuyez longuement sur une session pour la renommer ou la supprimer.",
  de: "Zum Aktualisieren nach unten ziehen; in einer Unterhaltung oder den Einstellungen vom linken Rand wischen, um zurückzugehen; eine Sitzung zum Umbenennen oder Löschen gedrückt halten.",
  es: "Desliza hacia abajo para actualizar; en una conversación o en Ajustes, desliza desde el borde izquierdo para volver; mantén pulsada una sesión para cambiarle el nombre o eliminarla.",
  "pt-BR": "Puxe para baixo para atualizar; em uma conversa ou nas configurações, deslize da borda esquerda para voltar; mantenha uma sessão pressionada para renomeá-la ou excluí-la.",
  it: "Trascina verso il basso per aggiornare; in una conversazione o nelle impostazioni, scorri dal bordo sinistro per tornare indietro; tieni premuta una sessione per rinominarla o eliminarla.",
};
for (const [locale, tip] of Object.entries(ONBOARDING_GESTURE_TIPS)) {
  if (ONBOARDING_COPY[locale]?.steps?.[0]) ONBOARDING_COPY[locale].steps[0].points.push(tip);
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
  el.onboardingClose.setAttribute("aria-label", window.stepsembleI18n?.t("Close") || "Close");
  el.onboardingLanguageLabel.textContent = copy.language;
  el.onboardingAppearanceLabel.textContent = copy.appearance;
  if (el.setupGuideTitle) el.setupGuideTitle.textContent = copy.guideTitle;
  if (el.setupGuideSubtitle) el.setupGuideSubtitle.textContent = copy.guideSubtitle;
  el.onboardingLanguage.value = settings.locale;
  const languageLabels = ONBOARDING_LANGUAGE_LABELS[settings.locale] || ONBOARDING_LANGUAGE_LABELS.en;
  [...el.onboardingLanguage.options].forEach((option, index) => { option.textContent = languageLabels[index] || option.textContent; });
  el.onboardingAppearance.value = settings.theme;
  for (const option of el.onboardingAppearance.options) option.textContent = window.stepsembleI18n?.t(option.value === "auto" ? "System" : option.value === "light" ? "Light" : "Dark") || option.textContent;
}

async function completeOnboarding() {
  // A first-login catalog request can still be settling when the user taps
  // Skip/Close.  Hydrate once more in that case, then refresh the list before
  // dismissing the guide so the app never lands on an unexplained blank view.
  if (!machines.length) {
    try {
      await hydrateMachineCatalog();
      if (machines.length) await refreshSessions();
    } catch (error) {
      if (error?.status !== 401 && error?.message !== "unauthorized") {
        toast(machineCatalogStatusText("目前無法讀取設備清單", "Could not load device list"), true);
      }
    }
  }
  // Keep Settings → Open guide a local action: once the catalog is already
  // hydrated, closing the guide must not trigger another network load.
  try { localStorage.setItem(ONBOARDING_KEY, "complete"); } catch {}
  el.onboarding?.classList.add("hidden");
}

function openOnboarding(force = false) {
  if (!el.onboarding) return;
  if (!force) {
    try {
      if (migratedStorageValue(localStorage, ONBOARDING_KEY, LEGACY_ONBOARDING_KEYS) === "complete") return;
    } catch {}
  }
  onboardingStep = 0;
  if (!el.onboardingLanguage.options.length) {
    for (const locale of window.stepsembleI18n?.locales || [{ id: "en", label: "English" }]) {
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
el.onboardingClose?.addEventListener("click", () => { void completeOnboarding(); });
el.onboardingSkip?.addEventListener("click", () => { void completeOnboarding(); });
el.onboardingBack?.addEventListener("click", () => { onboardingStep = Math.max(0, onboardingStep - 1); renderOnboarding(); });
el.onboardingNext?.addEventListener("click", () => {
  if (onboardingStep >= onboardingCopy().steps.length - 1) { void completeOnboarding(); return; }
  onboardingStep += 1;
  renderOnboarding();
});
el.onboardingLanguage?.addEventListener("change", () => {
  settings = saveSettings({ locale: window.stepsembleI18n?.normalizeLocale(el.onboardingLanguage.value) || "en" });
  window.stepsembleI18n?.setLocale(settings.locale);
  if (claudeAuthClient) renderClaudeAuth(claudeAuthClient.snapshot());
  renderOnboarding();
  renderSettings();
  renderContextDashboard();
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
let updateDeviceStatuses = new Map();
let updateCenterRequest = null;
let updateCenterAbort = null;
let updateCenterPollTimer = null;
let updateAllController = null;
let updateAllRequest = 0;
const updateRefreshTimers = new Set();
let updateCenterSummary = null;
let serviceWorkerRegistration = null;
let updateReadyNotified = false;

function updateText(key, vars = {}) {
  let text = window.stepsembleI18n?.t(key, vars) || key;
  for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
  return text;
}

function updateViewIsOpen() {
  return !!el.viewSettings && !el.viewSettings.classList.contains("hidden");
}

function cancelUpdateCenterRequest() {
  updateCenterAbort?.abort();
  updateCenterAbort = null;
  updateCenterRequest = null;
  updateStatusRequest += 1;
}

function formatUpdateTime(value) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return "";
  try {
    return new Intl.DateTimeFormat(window.stepsembleI18n?.getLocale?.() || settings.locale || "en", {
      dateStyle: "medium", timeStyle: "short",
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

function updateVersionText(value) {
  const version = String(value || "").trim();
  if (!version) return updateText("Not checked");
  return /^v/i.test(version) ? version : `v${version}`;
}

function updateDeviceName(machine = currentMachine()) {
  const configuredName = String(machine?.name || "").trim();
  return configuredName || updateText("Stepsemble device");
}

function updateRequestError(message, status = 0, reachable = false) {
  const error = new Error(message || "Update request failed");
  error.status = status;
  error.reachable = reachable;
  return error;
}

async function requestMachineUpdate(machine, endpoint, body, { signal, timeoutMs = 8000 } = {}) {
  const base = machine?.local ? "" : `/r/${encodeURIComponent(machine?.id || "")}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener?.("abort", abort, { once: true });
  try {
    const response = await fetch(`${base}${endpoint}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
    let result = null;
    try { result = await response.json(); } catch {}
    if (response.status === 401) {
      if (base) throw showRemoteAuthorizationState(base);
      showLogin();
      throw updateRequestError("Update request was not accepted", 401, false);
    }
    if (!response.ok) {
      const reachable = response.status !== 502 && response.status !== 504;
      throw updateRequestError("Update request was not accepted", response.status, reachable);
    }
    return { data: result, status: response.status };
  } catch (error) {
    if (error?.name === "AbortError") {
      if (signal?.aborted) throw error;
      throw updateRequestError("Update request timed out", 504, false);
    }
    throw error?.status !== undefined ? error : updateRequestError("Update request failed", 0, false);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", abort);
  }
}

async function fetchMachineUpdateStatus(machine, signal) {
  try {
    const result = await requestMachineUpdate(machine, "/api/update/status", undefined, { signal, timeoutMs: 7000 });
    if (!result.data || typeof result.data !== "object") throw updateRequestError("Update status was unavailable", 502, true);
    return result.data;
  } catch (error) {
    // Keep older configured devices visible with their live app version even
    // before they expose the update status endpoint. Update actions still
    // report 404 as skipped in Update all.
    if (![404, 405].includes(Number(error?.status))) throw error;
    try {
      const legacy = await requestMachineUpdate(machine, "/api/version", undefined, { signal, timeoutMs: 5000 });
      return { ...(legacy.data || {}), updateUnsupported: true };
    } catch {
      throw error;
    }
  }
}

function updateErrorIsUnsupported(error) {
  return [404, 405, 409].includes(Number(error?.status));
}

function updateEntryFor(machine) {
  return machine ? updateDeviceStatuses.get(machine.id) || null : null;
}

function updatePhaseText(data, machine, error = null) {
  const device = updateDeviceName(machine);
  if (error?.remote) return tKey(error.remoteKey || "deviceTrust.remoteAuthorizationError", { device });
  if (data?.updateUnsupported) return updateText("Update controls require a newer Stepsemble on {device}", { device });
  if (error) {
    if (updateErrorIsUnsupported(error) && [404, 405].includes(Number(error.status))) {
      return updateText("Update controls require a newer Stepsemble on {device}", { device });
    }
    return updateText("Update status unavailable on {device}", { device });
  }
  const updater = data?.updater;
  if (!updater) return updateText("Update status unavailable on {device}", { device });
  const hasAvailableUpdate = updater.pending === true
    || (updater.latestSha && updater.currentSha && updater.latestSha !== updater.currentSha);
  const phase = updater.phase || (hasAvailableUpdate ? "available" : "idle");
  if (phase === "checking") return updateText("Checking {device} for updates…", { device });
  if (phase === "deferred" || phase === "pending") {
    return updateText("Update pending on {device}; waiting for Agent work to finish", { device });
  }
  if (phase === "available") {
    return updater.latestVersion
      ? updateText("Update available on {device}: Stepsemble {version}", { device, version: updateVersionText(updater.latestVersion) })
      : updateText("Update available on {device}", { device });
  }
  if (phase === "error") return updateText("Update check failed on {device}", { device });
  if (phase === "unavailable") return updateText("Updater service is unavailable on {device}", { device });
  if (phase === "disabled") return updateText("Automatic updates are off on {device}", { device });
  if (phase === "up_to_date" || phase === "updated") {
    return updater.lastCheckedAt
      ? updateText("Up to date on {device}; checked {time}", { device, time: formatUpdateTime(updater.lastCheckedAt) })
      : updateText("Up to date on {device}", { device });
  }
  return updateText("Ready to check {device} for updates", { device });
}

function updateDeviceStateText(entry) {
  if (!entry) return updateText("Checking");
  if (!entry.error) return updateText("Online");
  return entry.reachable || updateErrorIsUnsupported(entry.error) ? updateText("Online") : updateText("Unavailable");
}

function updateNextCheckAt(updater) {
  if (updater?.nextCheckAt) return updater.nextCheckAt;
  if (!updater?.enabled || updater.installed === false || !updater?.lastCheckedAt) return null;
  const interval = Number(updater.intervalMinutes) || 60;
  const checked = Date.parse(updater.lastCheckedAt);
  return Number.isFinite(checked) ? new Date(checked + interval * 60 * 1000).toISOString() : null;
}

function updateMetric(label, value) {
  const item = document.createElement("div");
  item.className = "update-device-metric";
  const name = document.createElement("span");
  name.textContent = label;
  const content = document.createElement("strong");
  content.textContent = value;
  item.append(name, content);
  return item;
}

function renderUpdateDeviceRow(machine) {
  const entry = updateEntryFor(machine);
  const data = entry?.data;
  const updater = data?.updater;
  const row = document.createElement("article");
  row.className = "update-device-row";
  row.dataset.deviceId = machine.id;
  row.dataset.i18nIgnore = "true";
  row.classList.add(entry?.error ? "update-device-error" : "update-device-ready");
  if (updater?.phase) row.classList.add(`update-phase-${updater.phase}`);

  const heading = document.createElement("div");
  heading.className = "update-device-heading";
  const name = document.createElement("strong");
  name.textContent = updateDeviceName(machine);
  const state = document.createElement("span");
  state.className = "update-device-state";
  state.textContent = updateDeviceStateText(entry);
  heading.append(name, state);
  row.appendChild(heading);

  const versions = document.createElement("div");
  versions.className = "update-device-metrics";
  versions.append(
    updateMetric(updateText("Current version"), updateVersionText(data?.appVersion || data?.currentVersion || updater?.currentVersion)),
    updateMetric(updateText("Latest version"), updateVersionText(updater?.latestVersion || data?.latestVersion)),
  );
  row.appendChild(versions);

  const phase = document.createElement("p");
  phase.className = "update-device-phase";
  phase.setAttribute("role", "status");
  phase.textContent = updatePhaseText(data, machine, entry?.error || null);
  row.appendChild(phase);

  const times = document.createElement("div");
  times.className = "update-device-times";
  const last = updater?.lastCheckedAt && formatUpdateTime(updater.lastCheckedAt)
    ? updateText("Last check: {time}", { time: formatUpdateTime(updater.lastCheckedAt) })
    : updateText("No check yet");
  let next = updateText("Automatic checks are off");
  if (updater?.enabled && updater.installed !== false) {
    const nextCheckAt = updateNextCheckAt(updater);
    next = nextCheckAt && formatUpdateTime(nextCheckAt)
      ? updateText("Next automatic check: {time}", { time: formatUpdateTime(nextCheckAt) })
      : updateText("Next automatic check will appear after the first check");
  }
  const lastLine = document.createElement("span");
  lastLine.textContent = last;
  const nextLine = document.createElement("span");
  nextLine.textContent = next;
  times.append(lastLine, nextLine);
  row.appendChild(times);
  return row;
}

function renderUpdateStatus(data = updateStatusData) {
  const machine = currentMachine();
  const device = updateDeviceName(machine);
  const entry = updateEntryFor(machine);
  const statusData = entry ? entry.data : data;
  const error = entry?.error || null;
  const updater = statusData?.updater;
  if (el.updateAutoLabel) el.updateAutoLabel.textContent = updateText("Automatic updates for {device}", { device });
  if (el.updateCheckLabel) el.updateCheckLabel.textContent = updateText("Check {device} for updates", { device });
  if (!el.setAutoUpdate || !el.updateStatusCopy || !el.updateCheckStatus) return;

  if (!entry && !data) {
    el.setAutoUpdate.checked = false;
    el.setAutoUpdate.disabled = true;
    el.updateCheck.disabled = true;
    el.updateStatusCopy.textContent = updateText("Checking {device} for updates…", { device });
    el.updateCheckStatus.textContent = updateText("Checking {device} for updates…", { device });
    return;
  }
  if (error || !updater) {
    el.setAutoUpdate.checked = false;
    el.setAutoUpdate.disabled = true;
    el.updateCheck.disabled = true;
    el.updateStatusCopy.textContent = updateText("Update status unavailable on {device}", { device });
    el.updateCheckStatus.textContent = updatePhaseText(statusData, machine, error);
    return;
  }

  const installed = updater.installed === true;
  el.setAutoUpdate.checked = updater.enabled === true;
  el.setAutoUpdate.disabled = !installed;
  el.updateCheck.disabled = !installed;
  if (!installed) {
    el.updateStatusCopy.textContent = updateText("Install the Stepsemble updater on {device} to enable automatic updates", { device });
    el.updateCheckStatus.textContent = updateText("Updater service is not installed on {device}", { device });
    return;
  }
  el.updateStatusCopy.textContent = updater.enabled
    ? updateText("Checks GitHub every {minutes} minutes on {device}", { minutes: updater.intervalMinutes || 60, device })
    : updateText("Automatic updates are off on {device}", { device });
  el.updateCheckStatus.textContent = updatePhaseText(statusData, machine);
}

function renderUpdateCenter() {
  renderUpdateStatus();
  if (el.updateCenterSummary) {
    el.updateCenterSummary.textContent = updateCenterSummary
      ? updateText(updateCenterSummary.key, updateCenterSummary.vars)
      : "";
    el.updateCenterSummary.classList.toggle("hidden", !updateCenterSummary);
  }
  if (!el.updateDeviceList) return;
  el.updateDeviceList.innerHTML = "";
  for (const machine of machines) el.updateDeviceList.appendChild(renderUpdateDeviceRow(machine));
}

function setUpdateCenterSummary(key = "", vars = {}) {
  updateCenterSummary = key ? { key, vars } : null;
  if (el.updateCenterSummary) {
    el.updateCenterSummary.textContent = updateCenterSummary ? updateText(key, vars) : "";
    el.updateCenterSummary.classList.toggle("hidden", !updateCenterSummary);
  }
}

async function refreshUpdateCenter(force = false) {
  if (!updateViewIsOpen()) return null;
  if (updateCenterRequest && !force) return updateCenterRequest;
  updateCenterAbort?.abort();
  const controller = new AbortController();
  updateCenterAbort = controller;
  const request = ++updateStatusRequest;
  const generation = viewGeneration;
  const selectedAtStart = selectedId;
  const list = [...machines];
  const operation = Promise.all(list.map(async (machine) => {
    try {
      const data = await fetchMachineUpdateStatus(machine, controller.signal);
      return { id: machine.id, data, reachable: true };
    } catch (error) {
      return { id: machine.id, error, reachable: !!error?.reachable || updateErrorIsUnsupported(error) };
    }
  })).then((results) => {
    if (controller.signal.aborted || request !== updateStatusRequest || generation !== viewGeneration
      || selectedAtStart !== selectedId || !updateViewIsOpen()) return null;
    const next = new Map();
    for (const result of results) {
      next.set(result.id, result);
      if (result.error) machineStatuses.set(result.id, result.reachable ? "online" : "offline");
      else machineStatuses.set(result.id, "online");
    }
    updateDeviceStatuses = next;
    updateStatusData = next.get(selectedId)?.data || null;
    renderUpdateCenter();
    return next;
  }).finally(() => {
    if (updateCenterRequest === operation) updateCenterRequest = null;
    if (updateCenterAbort === controller) updateCenterAbort = null;
  });
  updateCenterRequest = operation;
  return operation;
}

function startUpdateCenterPolling() {
  if (!updateViewIsOpen()) return;
  if (!updateCenterPollTimer) {
    updateCenterPollTimer = setInterval(() => {
      if (!updateViewIsOpen()) { stopUpdateCenterPolling(); return; }
      void refreshUpdateCenter(true);
    }, 60 * 1000); // status refresh while Settings is open; updater checks remain hourly
  }
  void refreshUpdateCenter(true);
}

function stopUpdateCenterPolling() {
  if (updateCenterPollTimer) clearInterval(updateCenterPollTimer);
  updateCenterPollTimer = null;
  cancelUpdateCenterRequest();
  if (updateAllController) updateAllController.abort();
  updateAllController = null;
  if (el.updateAllDevices) el.updateAllDevices.disabled = false;
  updateAllRequest += 1;
  for (const timer of updateRefreshTimers) clearTimeout(timer);
  updateRefreshTimers.clear();
  updateCenterSummary = null;
  if (el.updateCenterSummary) {
    el.updateCenterSummary.textContent = "";
    el.updateCenterSummary.classList.add("hidden");
  }
}

async function loadUpdateStatus() {
  return refreshUpdateCenter();
}

// ===========================================================================
// Resource sync (Settings): read-only inventory comparison of global Pi
// extensions, skills, and packages between two devices. Nothing is ever
// installed here; a later phase may offer explicit install actions.
// ===========================================================================

const RESOURCE_SYNC_GROUPS = [["extensions", "Extensions"], ["skills", "Skills"], ["packages", "Packages"]];
let resourceSyncRequest = 0;
let resourceSyncController = null;
let resourceSyncState = null; // { diff, nameA, nameB } for re-render while Settings stays open

function resourceSyncEntryKey(group, entry) {
  if (group === "packages") return `${entry?.type || "path"}:${entry?.name || entry?.source || ""}`;
  return String(entry?.name || entry?.path || "");
}

function resourceSyncEntriesEqual(group, a, b) {
  if (!a || !b) return false;
  if (group === "packages") return String(a.source) === String(b.source);
  return !!a.hash && !!b.hash && a.hash === b.hash;
}

function resourceSyncStatusOrder(status) {
  return { diff: 0, "only-a": 1, "only-b": 2, same: 3 }[status] ?? 4;
}

function diffResourceInventories(inventoryA, inventoryB) {
  const groups = {};
  let differences = 0;
  for (const [group] of RESOURCE_SYNC_GROUPS) {
    const listA = Array.isArray(inventoryA?.groups?.[group]) ? inventoryA.groups[group] : [];
    const listB = Array.isArray(inventoryB?.groups?.[group]) ? inventoryB.groups[group] : [];
    const mapA = new Map(listA.map((entry) => [resourceSyncEntryKey(group, entry), entry]));
    const mapB = new Map(listB.map((entry) => [resourceSyncEntryKey(group, entry), entry]));
    const rows = [];
    for (const key of new Set([...mapA.keys(), ...mapB.keys()])) {
      const a = mapA.get(key) || null;
      const b = mapB.get(key) || null;
      const status = a && b ? (resourceSyncEntriesEqual(group, a, b) ? "same" : "diff") : (a ? "only-a" : "only-b");
      if (status !== "same") differences += 1;
      rows.push({ key, status, a, b });
    }
    rows.sort((x, y) => (resourceSyncStatusOrder(x.status) - resourceSyncStatusOrder(y.status))
      || x.key.localeCompare(y.key));
    groups[group] = { rows, counts: { a: listA.length, b: listB.length } };
  }
  return { groups, differences };
}

async function fetchMachineJSON(machine, endpoint, { signal, timeoutMs = 15000 } = {}) {
  const base = machine?.local ? "" : `/r/${encodeURIComponent(machine?.id || "")}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener?.("abort", abort, { once: true });
  try {
    const response = await fetch(`${base}${endpoint}`, {
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
    });
    if (response.status === 401) {
      if (base) throw showRemoteAuthorizationState(base);
      showLogin();
      const unauthorized = new Error("unauthorized");
      unauthorized.status = 401;
      throw unauthorized;
    }
    if (!response.ok) {
      const failure = new Error("resource request failed");
      failure.status = response.status;
      throw failure;
    }
    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      if (signal?.aborted) throw error;
      const timeout = new Error("resource request timed out");
      timeout.status = 504;
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", abort);
  }
}

function resourceSyncErrorText(error, machineA, machineB, nameA, nameB) {
  if ([404, 405].includes(Number(error?.status))) {
    // A remote host without the endpoint is simply an older Stepsemble.
    const remoteName = !machineA?.local ? nameA : (!machineB?.local ? nameB : null);
    if (remoteName) return updateText("Resource comparison needs a newer Stepsemble on {device}", { device: remoteName });
  }
  if ([502, 504].includes(Number(error?.status)) || error?.name === "TypeError") {
    const offlineName = !machineA?.local ? nameA : (!machineB?.local ? nameB : null) || nameA;
    return updateText("Could not reach {device}", { device: offlineName });
  }
  return updateText("Resource comparison failed");
}

function renderResourceSyncControls() {
  if (!el.syncBaseDevice || !el.syncCompareDevice) return;
  const previousBase = el.syncBaseDevice.value;
  const previousCompare = el.syncCompareDevice.value;
  const fill = (select, preferredId) => {
    select.innerHTML = "";
    for (const machine of machines) {
      const option = document.createElement("option");
      option.value = machine.id;
      option.textContent = machineDisplayName(machine) || machineDisplayHost(machine) || machine.id;
      select.appendChild(option);
    }
    if (preferredId && machines.some((machine) => machine.id === preferredId)) select.value = preferredId;
  };
  fill(el.syncBaseDevice, previousBase || selfId);
  fill(el.syncCompareDevice, previousCompare || machines.find((machine) => !machine.local)?.id || "");
  const singleDevice = machines.length < 2;
  el.syncBaseDevice.disabled = singleDevice;
  el.syncCompareDevice.disabled = singleDevice;
  if (el.syncCompare) el.syncCompare.disabled = singleDevice;
  if (singleDevice && el.syncCompareStatus) el.syncCompareStatus.textContent = updateText("Add another device to compare resources");
}

function renderResourceSyncResult() {
  if (!el.syncResult) return;
  el.syncResult.innerHTML = "";
  const state = resourceSyncState;
  if (!state) return;
  const { diff, nameA, nameB } = state;

  const summary = document.createElement("p");
  summary.className = "sync-summary";
  summary.textContent = diff.differences
    ? updateText("{count} difference(s) found", { count: diff.differences })
    : updateText("No differences: both devices match");
  el.syncResult.appendChild(summary);

  const statusText = { "only-a": "Only on {device}", "only-b": "Only on {device}", diff: "Different on each device" };
  for (const [group, label] of RESOURCE_SYNC_GROUPS) {
    const data = diff.groups[group];
    if (!data) continue;
    const sameRows = data.rows.filter((row) => row.status === "same");
    const diffRows = data.rows.filter((row) => row.status !== "same");
    if (!sameRows.length && !diffRows.length) continue;
    const section = document.createElement("section");
    section.className = "sync-group";
    const heading = document.createElement("h4");
    heading.className = "sync-group-title";
    heading.textContent = label;
    const counts = document.createElement("span");
    counts.className = "sync-group-counts";
    counts.textContent = updateText("{a} on {nameA} · {b} on {nameB}", { a: data.counts.a, nameA, b: data.counts.b, nameB });
    heading.appendChild(counts);
    section.appendChild(heading);

    if (diffRows.length) {
      const list = document.createElement("ul");
      list.className = "sync-rows";
      for (const row of diffRows) {
        const item = document.createElement("li");
        item.className = `sync-row sync-status-${row.status}`;
        const chip = document.createElement("span");
        chip.className = "sync-chip";
        chip.textContent = row.status === "diff"
          ? updateText("Different on each device")
          : updateText("Only on {device}", { device: row.status === "only-a" ? nameA : nameB });
        item.appendChild(chip);
        const name = document.createElement("span");
        name.className = "sync-name";
        name.textContent = row.a?.name || row.b?.name || row.key;
        item.appendChild(name);
        const paths = [...new Set([row.a?.source || row.a?.path, row.b?.source || row.b?.path].filter(Boolean))];
        if (paths.length) {
          const pathLine = document.createElement("span");
          pathLine.className = "sync-path";
          pathLine.textContent = paths.join("  vs  ");
          pathLine.title = paths.join("\n");
          item.appendChild(pathLine);
        }
        const descriptions = [...new Set([row.a?.description, row.b?.description].filter(Boolean))];
        if (descriptions.length) {
          const desc = document.createElement("span");
          desc.className = "sync-desc";
          desc.textContent = descriptions.join("  vs  ");
          item.appendChild(desc);
        }
        list.appendChild(item);
      }
      section.appendChild(list);
    }

    if (sameRows.length) {
      const details = document.createElement("details");
      details.className = "sync-same";
      const summaryRow = document.createElement("summary");
      summaryRow.textContent = updateText("{count} identical", { count: sameRows.length });
      details.appendChild(summaryRow);
      const list = document.createElement("ul");
      list.className = "sync-rows";
      for (const row of sameRows) {
        const item = document.createElement("li");
        item.className = "sync-row sync-status-same";
        const name = document.createElement("span");
        name.className = "sync-name";
        name.textContent = row.a?.name || row.b?.name || row.key;
        item.appendChild(name);
        const path = row.a?.path || row.b?.path || row.a?.source || row.b?.source;
        if (path) {
          const pathLine = document.createElement("span");
          pathLine.className = "sync-path";
          pathLine.textContent = path;
          item.appendChild(pathLine);
        }
        list.appendChild(item);
      }
      details.appendChild(list);
      section.appendChild(details);
    }
    el.syncResult.appendChild(section);
  }
}

async function compareResources() {
  if (!el.syncBaseDevice || !el.syncCompareDevice || !el.syncResult) return;
  const baseId = el.syncBaseDevice.value;
  const compareId = el.syncCompareDevice.value;
  if (!baseId || !compareId) return;
  if (baseId === compareId) {
    if (el.syncCompareStatus) el.syncCompareStatus.textContent = updateText("Pick two different devices to compare");
    return;
  }
  const machineA = machines.find((machine) => machine.id === baseId);
  const machineB = machines.find((machine) => machine.id === compareId);
  if (!machineA || !machineB) return;
  const nameA = machineDisplayName(machineA) || machineA.id;
  const nameB = machineDisplayName(machineB) || machineB.id;
  const request = ++resourceSyncRequest;
  resourceSyncController?.abort();
  const controller = new AbortController();
  resourceSyncController = controller;
  el.syncCompare.disabled = true;
  if (el.syncCompareStatus) el.syncCompareStatus.textContent = updateText("Comparing resources…");
  try {
    const [inventoryA, inventoryB] = await Promise.all([
      fetchMachineJSON(machineA, "/api/pi-resources", { signal: controller.signal }),
      fetchMachineJSON(machineB, "/api/pi-resources", { signal: controller.signal }),
    ]);
    if (request !== resourceSyncRequest) return;
    resourceSyncState = { diff: diffResourceInventories(inventoryA, inventoryB), nameA, nameB };
    renderResourceSyncResult();
    if (el.syncCompareStatus) el.syncCompareStatus.textContent = "";
  } catch (error) {
    if (request !== resourceSyncRequest) return;
    if (el.syncCompareStatus) el.syncCompareStatus.textContent = resourceSyncErrorText(error, machineA, machineB, nameA, nameB);
  } finally {
    if (request === resourceSyncRequest && el.syncCompare) el.syncCompare.disabled = machines.length < 2;
  }
}

function resetResourceSync() {
  resourceSyncRequest += 1;
  resourceSyncController?.abort();
  resourceSyncController = null;
  resourceSyncState = null;
  if (el.syncResult) el.syncResult.innerHTML = "";
  if (el.syncCompareStatus) el.syncCompareStatus.textContent = "";
}

function scheduleUpdateRefreshes(machineId = null) {
  const refreshAllDevices = machineId === null;
  for (const delay of [2500, 7000, 14000]) {
    const timer = setTimeout(() => {
      updateRefreshTimers.delete(timer);
      if (!updateViewIsOpen() || (!refreshAllDevices && selectedId !== machineId)) return;
      // Update All needs every row refreshed; an individual Check may remain
      // scoped to the device that was selected when it started.
      void refreshUpdateCenter(true);
      loadVersion();
      void checkForClientUpdate();
    }, delay);
    updateRefreshTimers.add(timer);
  }
}

async function saveAutomaticUpdates(enabled) {
  const machine = currentMachine();
  if (!el.setAutoUpdate || !machine) return;
  const generation = viewGeneration;
  const selectedAtStart = selectedId;
  cancelUpdateCenterRequest();
  el.setAutoUpdate.disabled = true;
  try {
    const result = await requestMachineUpdate(machine, "/api/update/settings", { enabled });
    if (generation !== viewGeneration || selectedAtStart !== selectedId || !updateViewIsOpen()) return;
    updateDeviceStatuses.set(machine.id, { id: machine.id, data: result.data, reachable: true });
    updateStatusData = result.data;
    renderUpdateCenter();
    toast(updateText(enabled ? "Automatic updates enabled for {device}" : "Automatic updates disabled for {device}", { device: updateDeviceName(machine) }));
  } catch (error) {
    if (generation !== viewGeneration || selectedAtStart !== selectedId || !updateViewIsOpen()) return;
    renderUpdateStatus(updateStatusData);
    toast(updateText("Could not save update settings on {device}", { device: updateDeviceName(machine) }), true);
  }
}

async function runUpdateCheck() {
  const machine = currentMachine();
  if (!el.updateCheck || !machine) return;
  const generation = viewGeneration;
  const selectedAtStart = selectedId;
  const device = updateDeviceName(machine);
  let started = false;
  cancelUpdateCenterRequest();
  el.updateCheck.disabled = true;
  if (el.updateCheckStatus) el.updateCheckStatus.textContent = updateText("Checking {device} for updates…", { device });
  try {
    await requestMachineUpdate(machine, "/api/update/run", {});
    if (generation !== viewGeneration || selectedAtStart !== selectedId || !updateViewIsOpen()) return;
    started = true;
    if (el.updateCheckStatus) el.updateCheckStatus.textContent = updateText("Update check started on {device}", { device });
    toast(updateText("Update check started on {device}", { device }));
    scheduleUpdateRefreshes(machine.id);
  } catch (error) {
    if (generation !== viewGeneration || selectedAtStart !== selectedId || !updateViewIsOpen()) return;
    renderUpdateStatus(updateStatusData);
    toast(updateText("Could not start an update check on {device}", { device }), true);
  } finally {
    if (generation === viewGeneration && selectedAtStart === selectedId && updateViewIsOpen()) {
      if (started) el.updateCheck.disabled = false;
      else renderUpdateStatus(updateStatusData);
    }
  }
}

async function runUpdateAll() {
  if (!el.updateAllDevices || updateAllController || !machines.length) return;
  const request = ++updateAllRequest;
  const generation = viewGeneration;
  const list = [...machines];
  const controller = new AbortController();
  cancelUpdateCenterRequest();
  updateAllController = controller;
  el.updateAllDevices.disabled = true;
  setUpdateCenterSummary("Asking {count} devices to check for updates…", { count: list.length });
  const counts = { started: 0, skipped: 0, failed: 0 };
  try {
    await Promise.all(list.map(async (machine) => {
      try {
        const result = await requestMachineUpdate(machine, "/api/update/run", {}, { signal: controller.signal });
        if (result.data?.started !== false) counts.started += 1;
        else counts.skipped += 1;
      } catch (error) {
        if (updateErrorIsUnsupported(error)) counts.skipped += 1;
        else counts.failed += 1;
      }
    }));
    if (request !== updateAllRequest || generation !== viewGeneration || !updateViewIsOpen()) return;
    setUpdateCenterSummary("Update all complete: {started} started, {skipped} skipped, {failed} failed.", counts);
    // Coalesce the delayed follow-up work into one timer set for the whole
    // center instead of scheduling the same three timers once per device.
    scheduleUpdateRefreshes();
    await refreshUpdateCenter(true);
  } finally {
    if (updateAllController === controller) updateAllController = null;
    if (request === updateAllRequest && generation === viewGeneration && updateViewIsOpen()) {
      el.updateAllDevices.disabled = false;
    }
  }
}

async function checkForClientUpdate() {
  const reloadAttemptKey = "stepsemble.clientReloadAttempt";
  const legacyReloadAttemptKeys = ["piharbor.clientReloadAttempt", "piweb.clientReloadAttempt"];
  try {
    const response = await fetch("/api/version", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) return;
    const data = await response.json();
    const serverVersion = String(data.appVersion || "").trim();
    if (!serverVersion || serverVersion === CLIENT_APP_VERSION) {
      sessionStorage.removeItem(reloadAttemptKey);
      for (const key of legacyReloadAttemptKeys) sessionStorage.removeItem(key);
      return;
    }
    if (rpc?.streaming) {
      if (!updateReadyNotified) toast(updateText("Stepsemble update ready; reload after the current work finishes"));
      updateReadyNotified = true;
      return;
    }
    updateReadyNotified = false;
    const registration = serviceWorkerRegistration || await navigator.serviceWorker?.getRegistration?.();
    await registration?.update?.().catch(() => {});
    const previousAttempt = Number(migratedStorageValue(sessionStorage, reloadAttemptKey, legacyReloadAttemptKeys)) || 0;
    if (Date.now() - previousAttempt < 15_000) return;
    sessionStorage.setItem(reloadAttemptKey, String(Date.now()));
    location.reload();
  } catch {}
}

function renderSettings() {
  const selectedMachine = currentMachine();
  el.setMachineName.textContent = machineDisplayName(selectedMachine) || machineDisplayName(currentHost) || "—";
  el.setMachineHost.textContent = machineDisplayHost(selectedMachine) || "—";
  el.setPiVersion.textContent = window._piVersion || "…";
  if (el.setAppVersion) el.setAppVersion.textContent = `v${window._appVersion || CLIENT_APP_VERSION}`;
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
  renderIncomingGrants();
  renderResourceSyncControls();
  void refreshMachineStatuses();
  void refreshIncomingGrants();
  renderUpdateCenter();
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
    ? provider.models.map((model) => {
      const parts = [model.id];
      if (model.name && model.name !== model.id) parts.push(model.name);
      if (model.reasoning) {
        if (parts.length < 2) parts.push(""); // keep the thinking marker in the third slot
        parts.push("thinking");
      }
      return parts.join(" | ");
    }).join("\n")
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
    warning.textContent = tKey("provider.readFailed", { detail: modelProviderError });
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
    const parts = line.split("|").map((part) => part.trim());
    const id = parts[0] || "";
    const name = parts[1] || "";
    // Optional third field marks a reasoning model so Pi keeps thinking
    // levels (off stays the only level for models without the marker).
    const thinking = /^(thinking|reasoning|思考)$/i.test(parts[2] || "");
    // Send an explicit false as well: removing the marker in the editor must
    // clear a previously stored thinkingLevelMap instead of leaving stale
    // provider capabilities in models.json.
    return { id, ...(name ? { name } : {}), reasoning: thinking };
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
  return window.stepsembleI18n?.t(type === "oauth" ? "Sign in with an account" : "Use an API key") || (type === "oauth" ? "Sign in with an account" : "Use an API key");
}

const PROVIDER_CATEGORY_META = Object.freeze({
  free: { label: "免費／免帳戶", note: tKey("provider.localService") },
  paid: { label: "API key／付費服務", note: tKey("provider.apiKeyNote") },
  account: { label: "帳戶登入", note: tKey("provider.accountNote") },
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
    title.textContent = window.stepsembleI18n?.t(meta.label) || meta.label;
    const note = document.createElement("small");
    note.textContent = `${providers.length}${window.stepsembleI18n?.t("個服務") || " service(s)"} · ${window.stepsembleI18n?.t(meta.note) || meta.note}`;
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
      name.textContent = window.stepsembleI18n?.providerName(provider) || provider.name;
      const description = document.createElement("small");
      description.textContent = window.stepsembleI18n?.providerDescription(provider) || provider.description;
      copy.append(name, description);
      const status = document.createElement("span");
      status.className = "provider-preset-status";
      status.textContent = provider.configured ? (window.stepsembleI18n?.t("已設定") || "Configured") : "";
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
  if (el.providerSelectedName) el.providerSelectedName.textContent = window.stepsembleI18n?.providerName(provider) || provider.name;
  if (el.providerSelectedDescription) el.providerSelectedDescription.textContent = window.stepsembleI18n?.providerDescription(provider) || provider.description || "";
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
      el.providerSwitchDevice.textContent = window.stepsembleI18n?.t("Switch device") || "Switch device";
    }
    if (el.providerSimpleStatus) {
      el.providerSimpleStatus.textContent = updateText("Update Stepsemble on this device to add or change provider credentials.");
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
    ? (provider.configured ? tKey("provider.added", { name: provider.name }) : "Scan this computer for local models.")
    : (provider.configured ? tKey("provider.alreadySignedIn", { name: provider.name }) : tKey("provider.chooseMethod"));
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
    // A remote device running an older Stepsemble can still use /api/models, but
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
        providerCatalogNotice = "This device is running an older Stepsemble. The catalog is view-only until it is updated.";
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
  const hadProviderSheet = !!extensionUiRequest?.kind;
  if (hadProviderSheet) extensionUiRequest = null;
  providerAuthNotice = "";
  providerAuthUrl = "";
  if (hadProviderSheet) {
    el.extensionUiSheet?.classList.add("hidden");
    el.extensionUiInput.value = "";
    el.extensionUiEditor.value = "";
    el.extensionUiInput.type = "text";
    el.extensionUiStatus.textContent = "";
  }
  renderNextNativeDialog();
}

function resetProviderDialogControls() {
  for (const control of [el.extensionUiSubmit, el.extensionUiCancel, el.extensionUiInput, el.extensionUiEditor]) control.disabled = false;
  el.extensionUiStatus.textContent = "";
}

function showProviderAuthPrompt(request, run) {
  if (!request || !run || run.hostBase !== apiBase) return;
  if (extensionUiRequest?.kind === "provider-auth" && extensionUiRequest.runId === run.runId && extensionUiRequest.id === request.id) return;
  suspendNativeDialog();
  providerAuthNotice = providerAuthNotice || "";
  providerAuthRequest = request;
  extensionUiRequest = { kind: "provider-auth", runId: run.runId, id: request.id, method: request.type, hostBase: run.hostBase };
  const renderedRequest = extensionUiRequest;
  resetProviderDialogControls();
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
    link.textContent = window.stepsembleI18n?.t("Open official sign-in page") || "Open official sign-in page";
    link.addEventListener("click", () => window.open(providerAuthUrl, "_blank", "noopener,noreferrer"));
    el.extensionUiOptions.appendChild(link);
  }

  if (request.type === "select") {
    for (const option of Array.isArray(request.options) ? request.options : []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "action-row extension-ui-option";
      button.textContent = option.description ? `${option.label} · ${option.description}` : option.label;
      button.addEventListener("click", event => { if (event.detail < 2) void finishExtensionUi({ value: option.id }, renderedRequest); });
      el.extensionUiOptions.appendChild(button);
    }
  } else {
    el.extensionUiInput.placeholder = request.placeholder || (request.type === "secret" ? "貼上 API key" : "輸入內容");
    el.extensionUiInput.value = "";
    el.extensionUiInput.classList.remove("hidden");
    el.extensionUiSubmit.textContent = "送出";
    el.extensionUiSubmit.classList.remove("hidden");
    el.extensionUiSubmit.onclick = event => { if (event.detail < 2) void finishExtensionUi({ value: el.extensionUiInput.value }, renderedRequest); };
  }
  el.extensionUiSheet.classList.remove("hidden");
  if (request.type !== "select") el.extensionUiInput.focus();
}

function showProviderAuthNotify(event, run) {
  if (!event || !run || run.hostBase !== apiBase) return;
  suspendNativeDialog();
  extensionUiRequest = { kind: "provider-notice", runId: run.runId, hostBase: run.hostBase };
  resetProviderDialogControls();
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
    code.textContent = tKey("provider.verificationCode", { code: event.userCode });
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
      ? tKey("provider.authTimeout")
      : event.reason === "replaced"
        ? tKey("provider.authSuperseded")
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
  if (el.providerSimpleStatus) el.providerSimpleStatus.textContent = tKey("provider.apiKeyLocal", { name: providerDialogPreset.name });
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
    ? (providerDialogPreset.configured ? tKey("provider.added", { name: providerDialogPreset.name }) : "Scan this computer for local models.")
    : (providerDialogPreset.configured ? tKey("provider.alreadySignedIn", { name: providerDialogPreset.name }) : tKey("provider.chooseMethod"));
}

function openProviderAuthStream(after = -1) {
  const run = providerAuthRun;
  if (!run || run.streamEnded || run.hostBase !== apiBase) return;
  const baseAtStart = run.hostBase;
  const stream = new EventSource(baseAtStart + "/api/provider-auth/stream?runId=" + encodeURIComponent(run.runId) + "&after=" + encodeURIComponent(after));
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
    if (baseAtStart) showRemoteAuthorizationState(baseAtStart);
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
    hostBase: apiBase,
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
  const baseAtStart = apiBase;
  try {
    const result = await post("/api/provider-auth/start", { providerId: provider.id, authType });
    if (baseAtStart !== apiBase) return;
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
    setProviderFormError(tKey("provider.apiKeyRequired"));
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
    if (el.providerSimpleStatus) el.providerSimpleStatus.textContent = tKey("provider.apiKeyRejected");
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
    toast(tKey("provider.addedWithModels", { name: provider.name }));
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
  if (run.hostBase !== apiBase) return;
  try { await post("/api/provider-auth/cancel", { runId: run.runId }); } catch {}
}

async function removeProviderAuth() {
  const provider = providerDialogPreset;
  if (!provider?.configured) return;
  const isFree = provider.kind === "free";
  const confirmText = isFree
    ? `確定移除「${provider.name}」？\n之後仍可從免費清單重新加入。`
    : tKey("provider.removeAuthConfirm", { name: provider.name });
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
  if (!provider?.id || !window.confirm(tKey("provider.deleteConfirm", { id: provider.id }))) return;
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
        modelProviderNotice = "Provider management requires Stepsemble 1.10.5 or later on this device.";
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
      error.textContent = tKey("runtime.loadFailed", { detail: e.message || "unknown error" });
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

// ---- Provider config portability ----
function downloadProviderConfig(includeSecrets) {
  const suffix = includeSecrets ? "?secrets=1" : "";
  api("/api/model-config/export" + suffix).then((payload) => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `stepsemble-providers-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast(includeSecrets
      ? window.stepsembleI18n?.t("Provider config exported with API keys") || "Provider config exported with API keys"
      : window.stepsembleI18n?.t("Provider config exported") || "Provider config exported");
  }).catch((error) => toast(error.message || "Export failed", true));
}

async function importProviderConfig(file) {
  let payload;
  try { payload = JSON.parse(await file.text()); }
  catch { toast(window.stepsembleI18n?.t("Invalid JSON file") || "Invalid JSON file", true); return; }
  const providerIds = Object.keys(payload?.providers || {});
  if (!providerIds.length) { toast(window.stepsembleI18n?.t("No providers found in the imported file") || "No providers found in the imported file", true); return; }
  const summary = providerIds.map((id) => {
    const provider = payload.providers[id];
    const models = Array.isArray(provider?.models) ? provider.models.length : 0;
    return `${id} · ${models} models${hasSecrets(provider) ? " · key" : ""}`;
  });
  if (!window.confirm(`${window.stepsembleI18n?.t("Import these providers?") || "Import these providers?"}\n\n${summary.join("\n")}\n\n${window.stepsembleI18n?.t("Providers with the same ID will be replaced.") || "Providers with the same id are replaced."}`)) return;
  try {
    const result = await post("/api/model-config/import", { providers: payload.providers });
    toast(window.stepsembleI18n?.t("Imported {count} providers", { count: result.imported.length }) || `Imported ${result.imported.length} providers`);
    await loadModelVisibility(true, true);
  } catch (error) {
    toast(error.message || "Import failed", true);
  }
}

function hasSecrets(provider) { return !!(provider?.apiKey || provider?.oauth); }

el.providerConfigExport?.addEventListener("click", () => {
  const includeSecrets = window.confirm(window.stepsembleI18n?.t("Include API keys in the export file?") || "Include API keys in the export file?\n\nCancel = export without secrets (keys stay on this device).\nOK = include keys in plain text; keep the file safe.");
  downloadProviderConfig(includeSecrets);
});
el.providerConfigImport?.addEventListener("click", () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) void importProviderConfig(file);
  });
  input.click();
});

// ---- PWA 完成通知：訂閱 Web Push（iOS 需已安裝 PWA 且 https）。
function urlBase64ToUint8Array(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function currentPushSubscription(registration) {
  try { return await registration.pushManager.getSubscription(); } catch { return null; }
}

function setPushToggleState(state) {
  if (!el.pushToggle) return;
  const labels = {
    unsupported: window.stepsembleI18n?.t("Not available") || "Not available",
    enable: window.stepsembleI18n?.t("Enable") || "Enable",
    on: window.stepsembleI18n?.t("Notifications on") || "Notifications on",
    denied: window.stepsembleI18n?.t("Blocked in browser settings") || "Blocked in browser settings",
    busy: "…",
  };
  el.pushToggle.textContent = labels[state] || labels.enable;
  el.pushToggle.dataset.pushState = state;
  el.pushToggle.disabled = state === "unsupported" || state === "denied";
}

async function refreshPushToggleState() {
  if (!el.pushToggle) return;
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    setPushToggleState("unsupported");
    return;
  }
  if (typeof Notification !== "undefined" && Notification.permission === "denied") {
    setPushToggleState("denied");
    return;
  }
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = registration ? await currentPushSubscription(registration) : null;
  if (subscription) setPushToggleState("on");
  else setPushToggleState("enable");
}

async function disablePushNotifications() {
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = registration ? await currentPushSubscription(registration) : null;
    if (subscription) {
      await post("/api/push/unsubscribe", { endpoint: subscription.endpoint });
      await subscription.unsubscribe();
    }
    toast(window.stepsembleI18n?.t("Notifications off") || "Notifications off");
  } catch {}
  void refreshPushToggleState();
}

async function enablePushNotifications() {
  try {
    if (typeof Notification !== "undefined" && Notification.permission !== "granted") {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { void refreshPushToggleState(); return; }
    }
    const registration = serviceWorkerRegistration || await navigator.serviceWorker.ready;
    const existing = await currentPushSubscription(registration);
    if (existing) { await post("/api/push/subscribe", existing.toJSON()); setPushToggleState("on"); return; }
    const config = await api("/api/push/config");
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.publicKey),
    });
    await post("/api/push/subscribe", subscription.toJSON());
    setPushToggleState("on");
    toast(window.stepsembleI18n?.t("Notifications on") || "Notifications on");
  } catch (error) {
    toast(error.message || "Could not enable notifications", true);
    void refreshPushToggleState();
  }
}

el.pushToggle?.addEventListener("click", () => {
  const state = el.pushToggle.dataset.pushState || "enable";
  if (state === "on") void disablePushNotifications();
  else if (state === "enable") void enablePushNotifications();
});
void refreshPushToggleState();
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
  settings = saveSettings({ locale: window.stepsembleI18n?.normalizeLocale(el.setLocale.value) || "en" });
  window.stepsembleI18n?.setLocale(settings.locale);
  if (claudeAuthClient) renderClaudeAuth(claudeAuthClient.snapshot());
  renderSettings();
  renderSessionList(el.search?.value || "");
  renderMachineSwitch();
  renderTokenList();
  updateComposerSummary();
  renderTaskProgress();
  renderContextDashboard();
  renderProjectChangesChrome();
  renderChangesBadge();
  if (projectChangesOpen()) renderProjectChanges();
  if (rpc?.streaming) setActivityLabel(rpc.activityLabel || "thinking");
  refreshActivityReceipts();
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
el.updateAllDevices?.addEventListener("click", () => { void runUpdateAll(); });
el.btnResetSettings?.addEventListener("click", () => {
  if (!confirm(tKey("settings.resetConfirm"))) return;
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
  renderMachineSwitch();
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
    const statusLabel = machineStatusText(status);
    row.querySelector(".m-dot").title = statusLabel;
    // Hostnames are implementation details; the row only needs the state.
    row.querySelector("small").textContent = m.id === selectedId
      ? tKey("deviceTrust.inUse", { status: statusLabel }) : statusLabel;
    const auth = document.createElement("span");
    auth.className = "m-auth";
    auth.textContent = machineAuthText(m);
    row.querySelector(".m-info").appendChild(auth);
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

function resetIncomingGrants() {
  incomingGrantsAbort?.abort();
  incomingGrantsAbort = null;
  incomingGrantsRequest = null;
  incomingGrants = null;
  incomingGrantsError = "";
  incomingGrantsRemoteError = false;
  incomingGrantsMachine = null;
  incomingGrantsRefreshAt = 0;
  incomingGrantsState = "idle";
  renderIncomingGrants();
}

function formatGrantDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat(window.stepsembleI18n?.getLocale?.() || settings.locale || "en", {
      dateStyle: "medium",
    }).format(date);
  } catch { return date.toISOString().slice(0, 10); }
}

function renderIncomingGrants() {
  if (!el.authorizedDeviceList || !el.authorizedDevicesStatus) return;
  el.authorizedDeviceList.innerHTML = "";
  if (incomingGrantsState === "loading" || incomingGrantsState === "idle") {
    el.authorizedDevicesStatus.textContent = tKey("deviceTrust.authorizedLoading");
    return;
  }
  if (incomingGrantsState === "unavailable" || incomingGrantsState === "error") {
    el.authorizedDevicesStatus.textContent = incomingGrantsRemoteError
      ? tKey("deviceTrust.remoteAuthorizationError", { device: machineDisplayName(currentMachine()) })
      : incomingGrantsError || tKey("deviceTrust.authorizedUnavailable");
    return;
  }
  if (!incomingGrants?.length) {
    el.authorizedDevicesStatus.textContent = tKey("deviceTrust.authorizedEmpty");
    return;
  }
  el.authorizedDevicesStatus.textContent = "";
  for (const grant of incomingGrants) {
    const row = document.createElement("div");
    row.className = "authorized-device-row";
    const copy = document.createElement("div");
    copy.className = "authorized-device-copy";
    const name = document.createElement("strong");
    name.textContent = machineDisplayName(grant.device);
    const details = document.createElement("small");
    details.textContent = tKey("deviceTrust.authorizedOn", { date: formatGrantDate(grant.createdAt) });
    copy.append(name, details);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn ghost authorized-device-revoke";
    button.textContent = tKey("deviceTrust.revoke");
    button.addEventListener("click", () => void revokeIncomingGrant(grant, button));
    row.append(copy, button);
    el.authorizedDeviceList.appendChild(row);
  }
}

async function refreshIncomingGrants(force = false) {
  const machine = currentMachine();
  const machineIdAtStart = machine?.id || null;
  if (!machineIdAtStart || el.viewSettings?.classList.contains("hidden")) return null;
  const now = Date.now();
  if (!force && incomingGrantsRequest) return incomingGrantsRequest;
  if (!force && incomingGrantsMachine === machineIdAtStart && now - incomingGrantsRefreshAt < 10_000) {
    renderIncomingGrants();
    return incomingGrants;
  }
  incomingGrantsAbort?.abort();
  const controller = new AbortController();
  incomingGrantsAbort = controller;
  incomingGrantsMachine = machineIdAtStart;
  incomingGrantsRefreshAt = now;
  incomingGrantsState = "loading";
  incomingGrantsError = "";
  incomingGrantsRemoteError = false;
  renderIncomingGrants();
  const generation = viewGeneration;
  const baseAtStart = apiBase;
  const request = (async () => {
    try {
      const response = await fetch(`${baseAtStart}/api/device-trust/grants`, {
        credentials: "same-origin", cache: "no-store", signal: controller.signal,
      });
      let data = null;
      try { data = await response.json(); } catch {}
      if (!response.ok) {
        if (response.status === 401) {
          if (baseAtStart) throw showRemoteAuthorizationState(baseAtStart);
          showLogin();
        }
        throw new Error(data?.error || response.statusText || "Authorized devices unavailable");
      }
      if (!Array.isArray(data?.grants)) throw new Error("Invalid authorized-device response");
      if (generation !== viewGeneration || machineIdAtStart !== selectedId || baseAtStart !== apiBase) return null;
      incomingGrants = data.grants;
      incomingGrantsError = "";
      incomingGrantsRemoteError = false;
      incomingGrantsState = "ready";
      renderIncomingGrants();
      return incomingGrants;
    } catch (error) {
      if (controller.signal.aborted) return null;
      if (generation === viewGeneration && machineIdAtStart === selectedId && baseAtStart === apiBase) {
        incomingGrantsState = "unavailable";
        incomingGrants = [];
        incomingGrantsError = error?.remote ? error.message : "";
        incomingGrantsRemoteError = !!error?.remote;
        renderIncomingGrants();
      }
      return null;
    } finally {
      if (incomingGrantsRequest === request) incomingGrantsRequest = null;
      if (incomingGrantsAbort === controller) incomingGrantsAbort = null;
    }
  })();
  incomingGrantsRequest = request;
  return request;
}

async function revokeIncomingGrant(grant, button) {
  const device = machineDisplayName(grant?.device);
  if (!grant?.grantId || !confirm(tKey("deviceTrust.revokeConfirm", { device }))) return;
  button.disabled = true;
  const baseAtStart = apiBase;
  try {
    const response = await fetch(`${baseAtStart}/api/device-trust/grants/revoke`, {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grantId: grant.grantId }),
    });
    let data = null;
    try { data = await response.json(); } catch {}
    if (response.status === 401) {
      if (baseAtStart) throw showRemoteAuthorizationState(baseAtStart);
      showLogin();
      throw new Error("unauthorized");
    }
    if (!response.ok) throw new Error(data?.error || response.statusText || "Could not revoke device access");
    toast(tKey("deviceTrust.revoked"));
    incomingGrantsRefreshAt = 0;
    await refreshIncomingGrants(true);
  } catch (error) {
    if (error?.remote && baseAtStart === apiBase) {
      incomingGrantsState = "unavailable";
      incomingGrants = [];
      incomingGrantsError = error.message;
      incomingGrantsRemoteError = true;
      renderIncomingGrants();
    }
    if (!error?.remote) toast(tKey("deviceTrust.revokeFailed"), true);
    button.disabled = false;
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
    let data = null;
    try { data = await response.json(); } catch {
      // Release the connection before a compatibility probe makes its
      // fallback request, especially on Safari where the body stream is not
      // eagerly read.
      try { await response.arrayBuffer(); } catch {}
    }
    const result = { ok: response.ok, status: response.status, ...(typeof data?.authed === "boolean" ? { authed: data.authed } : {}) };
    if (response.status === 401 || (endpoint === "/api/machine" && data?.authed === false)) {
      if (base) showRemoteAuthorizationState(base);
      else showLogin();
    }
    return result;
  } catch { return null; }
  finally { clearTimeout(timeout); }
}
async function checkMachineStatus(machine) {
  const health = await fetchMachineStatusEndpoint(machine, "/api/health");
  // /api/health is intentionally public, so it cannot prove that a revoked
  // peer grant still authorizes the relay. Follow it with the authenticated
  // machine probe; this also keeps an in-flight health success from replacing
  // a remote-authorization offline state.
  if (health?.ok) {
    const machineInfo = await fetchMachineStatusEndpoint(machine, "/api/machine");
    const authorized = machineInfo?.ok && machineInfo.authed !== false;
    return authorized || [404, 405].includes(machineInfo?.status) ? "online" : "offline";
  }
  // Older Stepsemble instances do not expose /api/health yet, but /api/machine is
  // available on those builds. Treat that compatibility response as online
  // instead of showing a healthy, actively used device as offline.
  if (!health || ![404, 405].includes(health.status)) return "offline";
  const machineInfo = await fetchMachineStatusEndpoint(machine, "/api/machine");
  return machineInfo?.ok && machineInfo.authed !== false ? "online" : "offline";
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

function resetMachinePairReview({ invalidate = true } = {}) {
  if (invalidate) machinePairReviewRequest += 1;
  machinePairPreview = null;
  el.machinePairJoin && (el.machinePairJoin.disabled = false);
  el.machinePairPreview?.classList.add("hidden");
  if (el.machinePairJoin) {
    el.machinePairJoin.dataset.i18nKey = "deviceTrust.reviewCode";
    el.machinePairJoin.textContent = tKey("deviceTrust.reviewCode");
  }
  if (el.machinePairPreviewName) el.machinePairPreviewName.textContent = "";
  if (el.machinePairPreviewUrl) el.machinePairPreviewUrl.textContent = "";
  if (el.machinePairPreviewExpires) el.machinePairPreviewExpires.textContent = "";
  if (el.machinePairPreviewVersion) el.machinePairPreviewVersion.textContent = "";
}

function formatPairingExpiry(value) {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(window.stepsembleI18n?.getLocale?.() || settings.locale || "en", {
      dateStyle: "medium", timeStyle: "short",
    }).format(date);
  } catch { return date.toISOString(); }
}

async function openMachineDialog(machine = null, mode = machine ? "edit" : "add") {
  machineDialogExisting = machine;
  machineDialogMode = mode;
  machineDialogDeviceSettings = null;
  machineDialogRestartRequired = false;
  resetMachinePairReview();
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
  resetMachinePairReview();
  el.machineRestart?.classList.add("hidden");
  if (el.machineStatusNote) el.machineStatusNote.textContent = machine
    ? tKey("deviceTrust.inUse", { status: machineStatusText(machineStatuses.get(machine.id) || "unknown") })
    : (pairing ? tKey("deviceTrust.codeNotice") : tKey("deviceTrust.manualNote"));
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
  resetMachinePairReview();
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
  if (!response.ok) {
    const message = result.code === "dedicated_url_change"
      ? tKey("deviceTrust.dedicatedUrlChange")
      : result.code === "trust_state_unavailable"
        ? tKey("deviceTrust.trustStateUnavailable")
        : result.error || response.statusText || "設備設定失敗";
    const error = new Error(message);
    error.status = response.status;
    error.code = result.code;
    throw error;
  }
  return result;
}

async function localPairingRequest(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (response.status === 401) { showLogin(); throw new Error("Sign-in expired"); }
  let result = {};
  try { result = await response.json(); } catch {}
  if (!response.ok) {
    if (result.code === "remote_unauthorized") {
      const error = showRemoteAuthorizationState("");
      error.status = response.status;
      throw error;
    }
    const message = result.code === "dedicated_url_change"
      ? tKey("deviceTrust.dedicatedUrlChange")
      : result.code === "trust_state_unavailable"
        ? tKey("deviceTrust.trustStateUnavailable")
        : result.error || response.statusText || "Pairing request failed";
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return result;
}

async function generateMachinePairingOffer() {
  el.machinePairGenerate.disabled = true;
  setMachineFormError();
  resetMachinePairReview();
  try {
    const result = await localPairingRequest("/api/device-pairing/start", {});
    el.machinePairOffer.value = result.offer || "";
    el.machinePairOfferArea.classList.remove("hidden");
    if (el.machineStatusNote) el.machineStatusNote.textContent = tKey("deviceTrust.codeGenerated");
    try { await navigator.clipboard?.writeText(result.offer || ""); toast("配對碼已複製"); }
    catch { toast(tKey("deviceTrust.savedNotice")); }
  } catch (error) {
    setMachineFormError(error.message || "無法產生配對碼");
  } finally {
    el.machinePairGenerate.disabled = false;
  }
}

async function reviewMachinePairing() {
  const offer = String(el.machinePairCode?.value || "").trim();
  if (!offer) { setMachineFormError(tKey("deviceTrust.pasteCode")); return; }
  const reviewRequest = ++machinePairReviewRequest;
  el.machinePairJoin.disabled = true;
  setMachineFormError();
  if (el.machineStatusNote) el.machineStatusNote.textContent = tKey("deviceTrust.reviewDescription");
  try {
    const result = await localPairingRequest("/api/machines/pair/preview", { offer });
    if (reviewRequest !== machinePairReviewRequest || String(el.machinePairCode?.value || "").trim() !== offer) return;
    const candidate = result?.candidate;
    if (!candidate || typeof candidate.name !== "string" || typeof candidate.url !== "string") throw new Error("Pairing review unavailable");
    machinePairPreview = { offer, candidate };
    if (el.machinePairPreviewName) el.machinePairPreviewName.textContent = candidate.name;
    if (el.machinePairPreviewUrl) el.machinePairPreviewUrl.textContent = candidate.url;
    if (el.machinePairPreviewExpires) el.machinePairPreviewExpires.textContent = formatPairingExpiry(candidate.expiresAt);
    if (el.machinePairPreviewVersion) el.machinePairPreviewVersion.textContent = String(candidate.version);
    el.machinePairPreview?.classList.remove("hidden");
    el.machinePairJoin.dataset.i18nKey = "deviceTrust.confirmPair";
    el.machinePairJoin.textContent = tKey("deviceTrust.confirmPair");
    if (el.machineStatusNote) el.machineStatusNote.textContent = "";
  } catch (error) {
    if (reviewRequest !== machinePairReviewRequest || String(el.machinePairCode?.value || "").trim() !== offer) return;
    resetMachinePairReview({ invalidate: false });
    setMachineFormError(error.message || "Pairing review unavailable");
  } finally {
    if (reviewRequest === machinePairReviewRequest) el.machinePairJoin.disabled = false;
  }
}

async function pairReviewedMachine() {
  const offer = String(el.machinePairCode?.value || "").trim();
  if (!offer || !machinePairPreview || machinePairPreview.offer !== offer) {
    resetMachinePairReview();
    return reviewMachinePairing();
  }
  el.machinePairJoin.disabled = true;
  setMachineFormError();
  if (el.machineStatusNote) el.machineStatusNote.textContent = "";
  try {
    await localPairingRequest("/api/machines/pair", { offer, confirmed: true });
    closeMachineDialog();
    await reloadMachineCatalog();
    toast("設備配對成功");
  } catch (error) {
    setMachineFormError(error.message || "設備配對失敗");
    if (el.machineStatusNote) el.machineStatusNote.textContent = tKey("deviceTrust.pairingNote");
  } finally {
    el.machinePairJoin.disabled = false;
  }
}

function joinMachinePairing() {
  if (machinePairPreview) return void pairReviewedMachine();
  void reviewMachinePairing();
}

async function reloadMachineCatalog() {
  return hydrateMachineCatalog();
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
    ? tKey("device.testOk") : tKey("device.testFailed");
  el.machineTest.disabled = false;
}

async function saveMachineDialog() {
  const name = String(el.machineName?.value || "").trim();
  const url = String(el.machineUrl?.value || "").trim();
  const host = String(el.machineHost?.value || "").trim() || name;
  const existing = machineDialogExisting;
  const isLocal = !!existing?.local;
  const port = Number(el.machinePort?.value || 0);
  if (!name || (!isLocal && !url)) { setMachineFormError(tKey(isLocal ? "device.nameRequired" : "device.nameAndUrlRequired")); return; }
  if (isLocal && (!Number.isInteger(port) || port < 1024 || port > 65535)) {
    setMachineFormError("Stepsemble port 必須是 1024–65535 的整數。"); return;
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
        if (el.machineStatusNote) el.machineStatusNote.textContent = tKey("device.portRestartNote");
        toast(tKey("device.nameUpdated"));
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
  if (!machineDialogExisting?.local || !confirm(tKey("device.restartConfirm"))) return;
  el.machineRestart.disabled = true;
  if (el.machineStatusNote) el.machineStatusNote.textContent = "正在要求 Stepsemble 重新啟動…";
  try {
    await post("/api/device-restart", {});
    toast("Stepsemble 正在重新啟動");
    setTimeout(() => location.reload(), 1200);
  } catch (error) {
    el.machineRestart.disabled = false;
    setMachineFormError(error.message || "無法重新啟動 Stepsemble");
  }
}

async function deleteMachineDialog() {
  if (!machineDialogExisting || !confirm(tKey("device.deleteConfirm", { name: machineDialogExisting.name }))) return;
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
el.machinePairCode?.addEventListener("input", resetMachinePairReview);
el.machinePairJoin?.addEventListener("click", () => void joinMachinePairing());

// ===========================================================================
// 新對話
// ===========================================================================

let projectFolder = { path: null, parent: null };
let projectFolderRequest = null;
let projectFolderSequence = 0;

function isAbsoluteBrowsePath(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate || candidate === "." || candidate === "..") return false;
  // The server expands only a home marker, not arbitrary ~-prefixed input.
  if (candidate === "~" || candidate.startsWith("~/") || candidate.startsWith("~\\")) return true;
  // Cover POSIX paths, drive-letter paths, and UNC paths without assuming the
  // browser and the selected Stepsemble host use the same platform.
  return candidate.startsWith("/") || /^[A-Za-z]:[\\\\/]/.test(candidate) || candidate.startsWith("\\\\");
}

function validatedBrowsePath(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return isAbsoluteBrowsePath(candidate) ? candidate : null;
}

function cancelProjectFolderRequest() {
  projectFolderSequence += 1;
  projectFolderRequest?.abort();
  projectFolderRequest = null;
}

function browseText(key) {
  return window.stepsembleI18n?.t(key) || key;
}

function renderProjectFolderList(entries) {
  el.newFolderList.innerHTML = "";
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "project-folder-empty";
    empty.textContent = browseText("There are no subfolders to open");
    el.newFolderList.appendChild(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "project-folder-row";
    row.dataset.i18nIgnore = "";
    row.innerHTML = `<svg class="icon"><use href="#i-folder-filled"></use></svg><span class="project-folder-copy"><strong></strong><small></small></span><svg class="icon trailing"><use href="#i-chevron-right"></use></svg>`;
    row.querySelector("strong").textContent = entry.name;
    row.querySelector("small").textContent = entry.path;
    row.addEventListener("click", () => loadProjectFolder(entry.path));
    el.newFolderList.appendChild(row);
  }
}

async function loadProjectFolder(requestedPath = null) {
  const sequence = ++projectFolderSequence;
  const machineAtStart = selectedId;
  const baseAtStart = apiBase;
  const generation = viewGeneration;
  if (projectFolderRequest) projectFolderRequest.abort();
  const request = new AbortController();
  projectFolderRequest = request;
  el.newFolderPath.textContent = browseText("Loading folders…");
  // A directory is a new scroll surface. Native keyboard/touch momentum can
  // outlive scrollTop=0 (notably Chromium/Linux) and move newly inserted rows.
  // Replace only this lightweight region to discard the old scroll animation;
  // preserve keyboard focus without moving the independent outer form.
  const focusFolderList = el.newFolderList.contains(document.activeElement);
  const folderList = el.newFolderList.cloneNode(false);
  el.newFolderList.replaceWith(folderList);
  el.newFolderList = folderList;
  el.newFolderList.innerHTML = `<p class="project-folder-empty">${browseText("Loading folders…")}</p>`;
  if (focusFolderList) el.newFolderList.focus({ preventScroll: true });
  el.newFolderUp.disabled = true;
  try {
    // An empty initial home is intentional: /api/browse resolves it to the
    // selected host's APP_HOME. Never put ".", an empty string, or a stale
    // previous device home into the query string.
    const path = validatedBrowsePath(requestedPath);
    const query = path ? "?path=" + encodeURIComponent(path) : "";
    const data = await api("/api/browse" + query, { signal: request.signal });
    if (sequence !== projectFolderSequence || machineAtStart !== selectedId || baseAtStart !== apiBase || generation !== viewGeneration) return;
    projectFolder = { path: data.path || null, parent: data.parent || null };
    el.newCwd.value = data.path || "";
    el.newFolderPath.textContent = data.path || "—";
    el.newFolderUp.disabled = !data.parent || data.parent === data.path;
    renderProjectFolderList(data.entries || []);
    el.newFolderList.scrollTop = 0;
  } catch (e) {
    if (e.name === "AbortError" || sequence !== projectFolderSequence || machineAtStart !== selectedId || baseAtStart !== apiBase || generation !== viewGeneration) return;
    projectFolder = { path: null, parent: null };
    el.newCwd.value = "";
    el.newFolderPath.textContent = browseText("Load failed");
    el.newFolderList.innerHTML = "";
    const error = document.createElement("p");
    error.className = "project-folder-empty error-text";
    error.append(document.createTextNode(browseText("Could not read folder: ")));
    const detail = document.createElement("span");
    detail.dataset.i18nIgnore = "";
    detail.textContent = e.message || "";
    error.appendChild(detail);
    el.newFolderList.appendChild(error);
  } finally {
    if (projectFolderRequest === request) projectFolderRequest = null;
  }
}

function openNewDialog(initialCwd = null) {
  if (agentCatalogError || !agentCatalog.length) void loadAgentCatalog();
  el.newCwd.value = "";
  el.newName.value = "";
  if (el.newAgent) {
    renderNewAgentOptions();
    if ([...el.newAgent.options].some((option) => option.value === "pi" && !option.disabled)) el.newAgent.value = "pi";
  }
  if (el.newWorktree) el.newWorktree.checked = false;
  updateNewAgentNote();
  el.newDialog.classList.remove("hidden");
  // No-path is the deterministic boot request. A path supplied by a project
  // action is used only when it is already absolute (or an accepted ~ path).
  void loadProjectFolder(validatedBrowsePath(initialCwd));
}
el.btnNew.addEventListener("click", openNewDialog);
el.btnNewProject?.addEventListener("click", openNewDialog);
el.chatEmptyNewProject?.addEventListener("click", openNewDialog);
el.newCancel.addEventListener("click", () => {
  cancelProjectFolderRequest();
  el.newDialog.classList.add("hidden");
});

// ===========================================================================
// Escape 關閉：所有覆蓋層共用一條規則
// ===========================================================================

// Every dismissable layer is registered here, ordered from the topmost visual
// layer downwards. Escape closes only the top-most open layer, so a dialog
// opened above Settings never dismisses both at once. Layers that must not be
// dismissed this way (sign-in, the one-time key reveal) are intentionally
// absent, and a layer awaiting an answer keeps its own cancel semantics.
function dismissableLayers() {
  return [
    { element: el.imageLightbox, close: closeImageLightbox },
    { element: el.agentTaskCenter, close: closeAgentTaskCenter },
    { element: el.commandPalette, close: closeCommandPalette },
    { element: el.onboarding, close: () => void completeOnboarding() },
    { element: el.extensionUiSheet, close: () => { if (extensionUiRequest) finishExtensionUi({ cancelled: true }); } },
    { element: el.projectRenameDialog, close: () => el.projectRenameDialog.classList.add("hidden") },
    { element: el.renameDialog, close: () => el.renameDialog.classList.add("hidden") },
    { element: el.providerDialog, close: closeProviderDialog },
    { element: el.machineDialog, close: closeMachineDialog },
    { element: el.newDialog, close: () => { cancelProjectFolderRequest(); el.newDialog.classList.add("hidden"); } },
    { element: el.modelSheet, close: closeModelSheet },
    { element: el.projectActionSheet, close: closeProjectActions },
    { element: el.saSheet, close: closeSessionActions },
    { element: el.changesLayer, close: closeProjectChanges },
    // Inline settings disclosures behave like dialogs to the user: Escape must
    // close the open form before it is allowed to leave Settings entirely.
    { element: el.tokenNewRow, close: () => setTokenNewRow(false) },
    { element: el.tokenCreateRow, close: () => { el.tokenCreateRow.classList.add("hidden"); setTokenFormError(); } },
    { element: el.contextPopover, close: () => { setContextPopover(false); el.contextInfo?.focus({ preventScroll: true }); } },
  ];
}

function closeTopmostLayer() {
  const layer = dismissableLayers().find((item) => item.element && !item.element.classList.contains("hidden"));
  if (!layer) return false;
  layer.close();
  return true;
}

document.addEventListener("keydown", (event) => {
  // Single-key shortcuts, Gmail-style: they only fire from the list view with
  // no text field, palette, guide, or dialog in front.
  if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing) {
    const editable = event.target instanceof Element
      && (event.target.closest("input, textarea, select, [contenteditable]") || event.target.isContentEditable);
    const paletteOpen = el.commandPalette && !el.commandPalette.classList.contains("hidden");
    const listVisible = el.viewList && !el.viewList.classList.contains("hidden");
    const blocked = editable || paletteOpen || !listVisible
      || (el.onboarding && !el.onboarding.classList.contains("hidden"))
      || !!document.querySelector(".sheet-layer:not(.hidden)");
    if (!blocked && (event.key === "/" || event.key === "n" || event.key === "ArrowDown" || event.key === "ArrowUp")) {
      if (event.key === "/") {
        event.preventDefault();
        el.search?.focus({ preventScroll: true });
        return;
      }
      if (event.key === "n") {
        event.preventDefault();
        openNewDialog();
        return;
      }
      // Arrow keys walk the row buttons in DOM order; Enter opens natively.
      const rows = [...(el.sessionList?.querySelectorAll?.(".session-item-main") || [])];
      if (rows.length) {
        event.preventDefault();
        const active = document.activeElement instanceof Element
          ? rows.indexOf(document.activeElement.closest(".session-item-main"))
          : -1;
        const next = event.key === "ArrowDown"
          ? Math.min(rows.length - 1, active + 1)
          : (active < 0 ? rows.length - 1 : Math.max(0, active - 1));
        rows[next]?.focus({ preventScroll: false });
      }
      return;
    }
  }
  // Command palette toggle: Cmd/Ctrl+K from anywhere except text fields that
  // need the OS undo chord — the palette input itself never re-triggers it.
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey
    && String(event.key).toLowerCase() === "k" && event.target !== el.commandInput) {
    event.preventDefault();
    toggleCommandPalette();
    return;
  }
  if (event.key !== "Escape" || event.defaultPrevented) return;
  // A composing IME uses Escape to abandon its own candidate window.
  if (event.isComposing) return;
  // The slash menu and inline inputs handle Escape closer to the field.
  if (!el.slashMenu?.classList.contains("hidden")) return;
  if (closeTopmostLayer()) {
    event.preventDefault();
    return;
  }
  // With no layer open, Escape leaves Settings the same way the back button does.
  if (!el.viewModelSettings?.classList.contains("hidden")) { el.btnModelSettingsBack?.click(); event.preventDefault(); return; }
  if (!el.viewSettings?.classList.contains("hidden")) { hideSettings(); event.preventDefault(); }
});
el.newFolderUp.addEventListener("click", () => {
  if (projectFolder.parent) loadProjectFolder(projectFolder.parent);
});
el.newFolderHome.addEventListener("click", () => loadProjectFolder(null));
el.newStart.addEventListener("click", async () => {
  const connector = agentCatalog.find((item) => item.id === el.newAgent?.value);
  if (agentCatalogError || connector?.installed !== true) { toast(agentHubText("unavailable"), true); return; }
  const cwd = el.newCwd.value.trim();
  if (!cwd) { toast(browseText("Choose a folder first"), true); return; }
  cancelProjectFolderRequest();
  el.newDialog.classList.add("hidden");
  if (settings.removedProjects?.includes(cwd)) {
    settings = saveSettings({ removedProjects: settings.removedProjects.filter((value) => value !== cwd) });
  }
  await startNew(cwd, el.newName.value.trim() || null, connector.id, !!el.newWorktree?.checked);
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

// Installed mobile apps use the manifest orientation as their default. This
// runtime request covers browsers that expose Screen Orientation locking; a
// rejected request is expected in ordinary tabs and on iOS Safari.
function lockMobilePortrait() {
  if (!matchMedia("(hover: none) and (pointer: coarse)").matches) return;
  if (typeof screen.orientation?.lock !== "function") return;
  screen.orientation.lock("portrait").catch(() => {});
}
window.addEventListener("pageshow", lockMobilePortrait);

// ===========================================================================
// 啟動
// ===========================================================================

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    const messageType = event.data?.type;
    if (["STEPSEMBLE_OPEN_AGENT_TASK", "PI_HARBOR_OPEN_AGENT_TASK"].includes(messageType)
      && typeof event.data.taskId === "string") {
      const hit = agentTasks.find((task) => String(task.id || task.taskId || "") === event.data.taskId);
      if (hit) { void openAgentTaskFromHub(hit); }
      else { void refreshAgentTasks().then(() => { const task = agentTasks.find((item) => String(item.id || item.taskId || "") === event.data.taskId); if (task) void openAgentTaskFromHub(task); }); }
      return;
    }
    if (["STEPSEMBLE_OPEN_SESSION", "PI_HARBOR_OPEN_SESSION"].includes(messageType)
      && typeof event.data.file === "string") {
      const hit = sessionsCache.find((s) => s.file === event.data.file);
      if (hit) { void openExisting(hit); }
      return;
    }
    if (!["STEPSEMBLE_UPDATED", "PI_HARBOR_UPDATED"].includes(messageType) || !navigator.serviceWorker.controller) return;
    // Initial cache activation also broadcasts UPDATED. This document already
    // has those assets; reloading would discard a newly opened form/draft.
    if (event.data?.version === `stepsemble-shell-v${CLIENT_APP_VERSION}`) return;
    if (rpc?.streaming) {
      toast(updateText("Stepsemble update ready; reload after the current work finishes"), false);
      return;
    }
    toast(updateText("Stepsemble updated; reloading…"), false);
    setTimeout(() => location.reload(), 900);
  });
  (async () => {
    try {
      serviceWorkerRegistration = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
    } catch {
      serviceWorkerRegistration = await navigator.serviceWorker.register("/sw.js").catch(() => null);
    }
    await serviceWorkerRegistration?.update?.().catch(() => {});
    void checkForClientUpdate();
  })();
  window.addEventListener("pageshow", () => void checkForClientUpdate());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void checkForClientUpdate();
  });
}
boot();
