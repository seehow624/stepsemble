/* stepsemble v3.6.1 — project changes, resilient drafts, and mobile polish */
"use strict";

const CLIENT_APP_VERSION = "3.6.1";
const WORKSPACE_PANE = new URLSearchParams(location.search).get("pane") === "1";
// index.html is a Workspace pane, the Settings window, or the sign-in page the
// Workspace sends to. Opened any other way (a typed address, an old bookmark
// or home-screen icon, a pane outside the Workspace) it goes to the Workspace:
// the single-conversation page with its own session list no longer exists.
const PAGE_QUERY = new URLSearchParams(location.search);
const SETTINGS_WINDOW = !WORKSPACE_PANE && PAGE_QUERY.get("settings") === "1";
const SIGN_IN_PAGE = !WORKSPACE_PANE && !SETTINGS_WINDOW && PAGE_QUERY.get("returnWorkspace") === "1";
const PAGE_EMBEDDED = (() => { try { return window.top !== window.self; } catch { return true; } })();
const LEAVING_FOR_WORKSPACE = WORKSPACE_PANE ? !PAGE_EMBEDDED : !SETTINGS_WINDOW && !SIGN_IN_PAGE;
if (LEAVING_FOR_WORKSPACE) location.replace("/");
if (WORKSPACE_PANE) {
  document.documentElement.classList.add("workspace-embedded");
  // A split pane can be narrow on a desktop. Use the outer workspace viewport
  // for the chat Back button, rather than this iframe's own width.
  try {
    const outerMobile = parent.matchMedia("(max-width: 760px)");
    const update = () => document.documentElement.classList.toggle("workspace-mobile-pane", outerMobile.matches);
    update(); outerMobile.addEventListener?.("change", update);
  } catch {}
}

// The browser remains buildless, but feature-independent foundations live in
// small files loaded before this controller. This keeps deployment as simple
// as the original PWA while preventing storage, device, and display rules from
// being duplicated across future feature modules.
const foundation = window.stepsembleFoundation;
const sessionUtils = window.stepsembleSessionUtils;
const piSession = window.StepsemblePiSession;
const contextUtils = window.stepsembleContextUtils;
const openCodeContext = window.stepsembleOpenCodeContext;
const claudeStructuredRendering = window.stepsembleClaudeStructuredRendering;
const agentTranscriptPresentation = window.stepsembleAgentTranscriptPresentation;
if (!foundation || !sessionUtils || !contextUtils || !piSession || !agentTranscriptPresentation) throw new Error("Stepsemble foundation modules are missing");
const {
  SELECTED_KEY, SETTINGS_KEY, LEGACY_SETTINGS_KEYS, SETTINGS_VERSION,
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
  stuckSessions: $("stuck-sessions"),
  btnNew: $("btn-new"), btnNewProject: $("btn-new-project"), pullIndicator: $("pull-indicator"),
  agentHubCard: $("agent-hub-card"), agentHubTitle: $("agent-hub-title"), agentHubSummary: $("agent-hub-summary"), agentHubToggle: $("agent-hub-toggle"), agentHubBody: $("agent-hub-body"), agentHubRefresh: $("agent-hub-refresh"), agentHubOpenCenter: $("agent-hub-open-center"), agentHubConnectors: $("agent-hub-connectors"), agentTaskList: $("agent-task-list"),
  agentTaskCenter: $("agent-task-center"), agentTaskCenterClose: $("agent-task-center-close"), agentTaskCenterTitle: $("agent-task-center-title"), agentTaskCenterSummary: $("agent-task-center-summary"), agentTaskCenterSearch: $("agent-task-center-search"), agentTaskCenterFilter: $("agent-task-center-filter"), agentTaskCenterList: $("agent-task-center-list"), agentTaskCenterEmpty: $("agent-task-center-empty"),
  machineSwitch: $("machine-switch"), machineSwitchStatus: $("machine-switch-status"),
  machineCatalogStatus: $("machine-catalog-status"), machineCatalogStatusCopy: $("machine-catalog-status-copy"), machineCatalogRetry: $("machine-catalog-retry"),
  btnBack: $("btn-back"), chatTitle: $("chat-title"), chatSub: $("chat-sub"), chatAgentLogo: $("chat-agent-logo"),
  chatHeadInfo: $("chat-head-info"), thinkingStatus: $("thinking-status"), btnChatMenu: $("btn-chat-menu"),
  runTimer: $("run-timer"),
  btnChanges: $("btn-changes"), changesBadge: $("changes-badge"), changesLayer: $("changes-layer"),
  changesTitle: $("changes-title"), changesRepository: $("changes-repository"), changesRefresh: $("changes-refresh"), changesCommit: $("changes-commit"), changesClose: $("changes-close"),
  changesSummary: $("changes-summary"), changesFilesPane: $("changes-files-pane"), changesState: $("changes-state"), changesList: $("changes-list"),
  changesDiffPane: $("changes-diff-pane"), changesDetailBack: $("changes-detail-back"), changesDiffKind: $("changes-diff-kind"),
  changesDiffTitle: $("changes-diff-title"), changesDiffEmpty: $("changes-diff-empty"), changesDiff: $("changes-diff"),
  messages: $("messages"), scrollBottomBtn: $("scroll-bottom-btn"), queueNote: $("queue-note"), taskReplayNote: $("task-replay-note"),
  nativeRunState: $("native-run-state"), nativeRunIndicator: $("native-run-indicator"), nativeRunTitle: $("native-run-title"),
  nativeRunDetail: $("native-run-detail"), nativeRunMeta: $("native-run-meta"),
  taskProgress: $("task-progress"), taskProgressPanel: $("task-progress-panel"), taskProgressHeading: $("task-progress-heading"),
  taskProgressState: $("task-progress-state"), taskProgressList: $("task-progress-list"), taskProgressDetail: $("task-progress-detail"),
  taskProgressNotes: $("task-progress-notes"), taskProgressToggle: $("task-progress-toggle"), taskProgressIndicator: $("task-progress-indicator"),
  taskProgressCount: $("task-progress-count"),
  contextDashboard: $("context-dashboard"), contextProgress: $("context-progress"), contextProgressFill: $("context-progress-fill"),
  contextInfo: $("context-info"), contextPopover: $("context-popover"),
  contextInlinePercent: $("context-inline-percent"),
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
  approvalControl: $("approval-control"), btnApproval: $("btn-approval"), approvalLabel: $("approval-label"),
  approvalMenu: $("approval-menu"), approvalOptions: $("approval-options"), approvalMenuNote: $("approval-menu-note"),
  btnOpenSettings: $("btn-open-settings"), btnSettingsBack: $("btn-settings-back"), btnModelSettingsBack: $("btn-model-settings-back"), modelSettingsOpen: $("model-settings-open"), modelSettingsSummary: $("model-settings-summary"),
  settingsTitle: $("settings-title"), settingsNav: $("settings-nav"), settingsContentTitle: $("settings-content-title"),
  settingsHostDot: $("settings-host-dot"), settingsUpdatesBadge: $("settings-updates-badge"),
  settingsSummaryAppearance: $("settings-summary-appearance"), settingsSummaryDevices: $("settings-summary-devices"),
  settingsSummaryUpdates: $("settings-summary-updates"), settingsSummaryAbout: $("settings-summary-about"),
  settingsSummaryNotifications: $("settings-summary-notifications"),
  themeChoicesToggle: $("theme-choices-toggle"), themeCurrentName: $("theme-current-name"), themeCurrentSwatches: $("theme-current-swatches"),
  modelCatalogRefresh: $("model-catalog-refresh"),
  machineList: $("machine-list"), machineAdd: $("machine-add"), machinePair: $("machine-pair"), machineDialog: $("machine-dialog"), machineDialogTitle: $("machine-dialog-title"), machineStandardFields: $("machine-standard-fields"), machineName: $("machine-name"), machineUrl: $("machine-url"), machinePort: $("machine-port"), machinePortLabel: $("machine-port-label"), machineHost: $("machine-host"), machineStatusNote: $("machine-status-note"), machineFormError: $("machine-form-error"), machinePairArea: $("machine-pair-area"), machinePairCode: $("machine-pair-code"), machinePairJoin: $("machine-pair-join"), machinePairPreview: $("machine-pair-preview"), machinePairPreviewName: $("machine-pair-preview-name"), machinePairPreviewUrl: $("machine-pair-preview-url"), machinePairPreviewExpires: $("machine-pair-preview-expires"), machinePairPreviewVersion: $("machine-pair-preview-version"), machinePairOfferArea: $("machine-pair-offer-area"), machinePairOffer: $("machine-pair-offer"), machinePairGenerate: $("machine-pair-generate"), machineRestart: $("machine-restart"), machineSave: $("machine-save"), machineDelete: $("machine-delete"), machineTest: $("machine-test"), machineCancel: $("machine-cancel"), machineCancelBottom: $("machine-cancel-bottom"),
  authorizedDevicesStatus: $("authorized-devices-status"), authorizedDeviceList: $("authorized-device-list"),
  setMachineName: $("set-machine-name"), setMachineHost: $("set-machine-host"), setAppVersion: $("set-app-version"),
  btnLogout: $("btn-logout"), btnResetSettings: $("btn-reset-settings"), btnOpenOnboarding: $("btn-open-onboarding"), setupGuideTitle: $("setup-guide-title"), setupGuideSubtitle: $("setup-guide-subtitle"),
  updateAllDevices: $("update-all-devices"), updateInstallAll: $("update-install-all"), updateCenterSummary: $("update-center-summary"), updateDeviceList: $("update-device-list"),
  harnessUpdateTitle: $("harness-update-title"), harnessUpdateNote: $("harness-update-note"), harnessUpdateCheckAll: $("harness-update-check-all"), harnessUpdateApplyAll: $("harness-update-apply-all"), harnessUpdateSummary: $("harness-update-summary"), harnessUpdateList: $("harness-update-list"), harnessUpdateMissing: $("harness-update-missing"),
  syncBaseDevice: $("sync-base-device"), syncCompareDevice: $("sync-compare-device"), syncCompare: $("sync-compare"), syncCompareStatus: $("sync-compare-status"), syncResult: $("sync-result"),
  setLocale: $("set-locale"), setTheme: $("set-theme"), setDesignTheme: $("theme-choices"), setSidebarWidth: $("set-sidebar-width"), setSidebarWidthValue: $("set-sidebar-width-value"), setFontScale: $("set-font-scale"), setFontScaleValue: $("set-font-scale-value"), setCompact: $("set-compact"),
  btnImg: $("btn-img"), fileInput: $("file-input"), imgPreview: $("img-preview"),
  setReducedMotion: $("set-reduced-motion"), setThinking: $("set-thinking"),
  modelVisibilityList: $("model-visibility-list"), modelVisibilityRefresh: $("model-visibility-refresh"),
  modelListToolbar: $("model-list-toolbar"),
  modelAgentList: $("model-agent-list"), modelAgentSignin: $("model-agent-signin"), modelAgentSigninText: $("model-agent-signin-text"),
  modelAgentStatus: $("model-agent-status"), agentModelPanel: $("agent-model-panel"), agentModelStatus: $("agent-model-status"),
  claudeHelperPanel: $("claude-helper-panel"), claudeHelperText: $("claude-helper-text"), claudeHelperUpdate: $("claude-helper-update"),
  agentModelList: $("agent-model-list"), modelSettingsTopbarTitle: $("model-settings-topbar-title"),
  modelSettingsHeading: $("model-settings-heading"), modelSettingsIntro: $("model-settings-intro"),
  opencodeProviderPanel: $("opencode-provider-panel"), opencodeProviderStatus: $("opencode-provider-status"),
  opencodeProviderList: $("opencode-provider-list"),
  codexGatewayPanel: $("codex-gateway-panel"), codexGatewayStatus: $("codex-gateway-status"),
  codexGatewayList: $("codex-gateway-list"),
  providerConfigExport: $("provider-config-export"), providerConfigImport: $("provider-config-import"),
  pushToggle: $("push-toggle"), pushUnsupportedNote: $("push-unsupported-note"),
  piUsagePanel: $("pi-usage-panel"), usageSummaryCard: $("usage-summary-card"), usageSummaryRows: $("usage-summary-rows"), usageSummaryNote: $("usage-summary-note"),
  modelFilter: $("model-filter"), modelListSummary: $("model-list-summary"), providerAdd: $("provider-add"),
  providerDialog: $("provider-dialog"), providerDialogTitle: $("provider-dialog-title"), providerId: $("provider-id"),
  providerApi: $("provider-api"), providerBaseUrl: $("provider-base-url"), providerApiKey: $("provider-api-key"),
  providerModels: $("provider-models"), providerFormError: $("provider-form-error"), providerSave: $("provider-save"),
  providerCancel: $("provider-cancel"), providerCancelBottom: $("provider-cancel-bottom"), providerDelete: $("provider-delete"),
  opencodeProviderDialog: $("opencode-provider-dialog"), opencodeProviderDialogTitle: $("opencode-provider-dialog-title"),
  opencodeProviderId: $("opencode-provider-id"), opencodeProviderName: $("opencode-provider-name"),
  opencodeProviderBaseUrl: $("opencode-provider-base-url"), opencodeProviderApiKey: $("opencode-provider-api-key"),
  opencodeProviderModels: $("opencode-provider-models"), opencodeProviderFormError: $("opencode-provider-form-error"),
  opencodeProviderSave: $("opencode-provider-save"), opencodeProviderDelete: $("opencode-provider-delete"),
  opencodeProviderCancel: $("opencode-provider-cancel"), opencodeProviderCancelBottom: $("opencode-provider-cancel-bottom"),
  providerAdvancedFields: $("provider-advanced-fields"),
  newDialog: $("new-dialog"), newCwd: $("new-cwd"), newName: $("new-name"), newAgent: $("new-agent"), newWorktree: $("new-worktree"), newAgentNote: $("new-agent-note"), newAgentCapabilities: $("new-agent-capabilities"),
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
  thinkingSelect: $("thinking-select"), thinkingHint: $("thinking-hint"), modelClose: $("model-close"),
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
  agentTerminal: $("agent-terminal"), agentTerminalHost: $("agent-terminal-host"), agentTerminalTitle: $("agent-terminal-title"),
  agentTerminalClose: $("agent-terminal-close"), agentTerminalChoices: $("agent-terminal-choices"), agentTerminalLinks: $("agent-terminal-links"),
  agentTerminalScreen: $("agent-terminal-screen"), agentTerminalStatus: $("agent-terminal-status"), agentTerminalKeys: $("agent-terminal-keys"),
  agentTerminalForm: $("agent-terminal-form"), agentTerminalInput: $("agent-terminal-input"), agentTerminalSecret: $("agent-terminal-secret"),
  agentTerminalStop: $("agent-terminal-stop"), agentTerminalStatusButton: $("agent-terminal-status-button"), agentTerminalDone: $("agent-terminal-done"),
  quotaSourcesList: $("quota-sources-list"), quotaSourcesRefresh: $("quota-sources-refresh"),
};

// ===========================================================================
// 狀態
// ===========================================================================

let sessionsCache = [];
let sessionRenderLimit = 120;
let agentCatalog = [];
let agentCatalogError = false;
let agentTasks = [];
let agentTaskPollTimer = null;
let agentHubTicker = null;
let openCodeNativePollTimer = null;
let codexNativePollTimer = null;
let grokAcpPollTimer = null;
let acpPollTimer = null;
let claudeStructuredPollTimer = null;
let antigravityStructuredPollTimer = null;
let codexNativeHistoryButton = null;
let agentCatalogRequest = null;
let newAgentStartPending = false;
let newAgentOpenRequest = null;
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
let modelCatalogSources = new Map();
let configuredProviders = [];

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
let modelCatalogMachine = null;
let modelCatalogLoadedAt = 0;
let modelCatalogLoading = false;
let modelCatalogRequest = null;
const expandedModelProviders = new Set();
let providerDialogMode = "add";
let providerDialogExisting = null;
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
// Structured Claude/Codex adapters do not expose Pi's rpc_cmd. Their context
// endpoints are still tied to the visible session, so keep an independent
// request fence instead of letting a late response repaint the next host.
let nativeContextRequest = null;
let nativeContextRequestSequence = 0;
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
// One write at a time: a second stage or commit while the first is in flight
// would race the snapshot that replaces the list.
let changesMutationInFlight = false;

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
const post = (path, body, opts = {}) => api(path, {
  ...opts, method: "POST", headers: { "Content-Type": "application/json", ...(opts.headers || {}) }, body: JSON.stringify(body),
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

let workLogLocale = null;
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
  // Work-log labels are composed from keyed strings, so a language change
  // rebuilds them once the new locale is active.
  const workLocale = settings.locale || "en";
  if (workLogLocale !== null && workLogLocale !== workLocale) queueMicrotask(() => relabelWorkLog());
  workLogLocale = workLocale;
  renderContextDashboard();
}

matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => {
  if (settings.theme === "auto") applyAppearance();
});

// ===========================================================================
// 登入 / 登出
// ===========================================================================

function showLogin() {
  resetAgentHub();
  protocolConnections.reset();
  stopUpdateCenterPolling();
  closeChat(true);
  closeAgentTerminal({ silent: true, detach: true });
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
  if (LEAVING_FOR_WORKSPACE) return;
  applyAppearance();
  // The model label starts as English markup; render it in the chosen
  // language before any conversation reports its model.
  updateComposerSummary();
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
  } catch (error) {
    // A pane waits for a computer it cannot reach instead of asking to sign in.
    if (WORKSPACE_PANE && !(error?.status === 401 || error?.message === "unauthorized")) { waitForPaneHost(); return; }
  }
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
  harnessUpdateDataByDevice = new Map([...harnessUpdateDataByDevice].filter(([id]) => machines.some((machine) => machine.id === id)));
  updateStatusData = updateDeviceStatuses.get(selectedId)?.data || null;
  cancelUpdateCenterRequest();
  harnessUpdateRequest += 1;
  harnessUpdateController?.abort();
  harnessUpdateController = null;
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
// A sign-in reached from the Workspace returns there once it succeeds. The
// first sign-in on a device shows the setup guide first; the Workspace follows.
let workspaceAfterGuide = false;
function workspaceDestination() {
  const destination = new URL("/workspace.html", location.origin);
  for (const key of ["window", "ack", "source"]) {
    const value = PAGE_QUERY.get(key);
    if (/^[a-f0-9-]{36}$/.test(value) || key === "source" && value === "main") destination.searchParams.set(key, value);
  }
  return destination.href;
}
function returnToWorkspace() {
  if (!SIGN_IN_PAGE) return false;
  workspaceAfterGuide = true;
  openOnboarding(false);
  if (el.onboarding && !el.onboarding.classList.contains("hidden")) return true;
  location.replace(workspaceDestination());
  return true;
}

// A Workspace pane never falls back to the conversation list or a sign-in
// form while its computer is briefly unreachable. It says so and opens the
// conversation by itself once the computer answers.
let paneRetryTimer = 0, paneRetryAttempt = 0;
function waitForPaneHost() {
  el.login.classList.add("hidden");
  el.app.classList.remove("hidden");
  el.viewList.classList.add("hidden");
  el.viewChat.classList.remove("hidden");
  showChatEmpty();
  el.chatEmpty.textContent = tKey("workspace.hostWaiting");
  clearTimeout(paneRetryTimer);
  paneRetryTimer = setTimeout(retryPaneHost, Math.min(10000, 1000 * 2 ** paneRetryAttempt++));
}
function retryPaneHost() {
  clearTimeout(paneRetryTimer);
  paneRetryTimer = 0;
  void boot();
}
if (WORKSPACE_PANE) window.addEventListener("online", () => { if (paneRetryTimer) retryPaneHost(); });
// A pane's computer can be another machine that is asleep or offline: the
// relay answers 502/504, or the browser cannot reach this host at all. Other
// failures are reported as they are.
function paneHostUnreachable(error) {
  if (error?.status === 502 && error.message === "machine unreachable") return true;
  if (error?.status === 504 && error.message === "machine timeout") return true;
  return error instanceof TypeError && /Failed to fetch|Load failed|NetworkError/i.test(error.message || "");
}
function paneOpenErrorText(error) {
  const message = String(error?.message || "");
  if (message === "workspace_entry_not_found") return tKey("workspace.entryMissing");
  if (message === "workspace_host_missing") return tKey("workspace.hostMissing");
  return message || tKey("workspace.sessionUnavailable");
}

async function enterApp() {
  if (enterAppRequest) return enterAppRequest;
  enterAppRequest = (async () => {
    try {
      // This must settle before the list, version, or onboarding requests run.
      await hydrateMachineCatalog();
    } catch (error) {
      if (error?.status === 401 || error?.message === "unauthorized") throw error;
      // Signed in, but the device list failed. The Workspace loads its own
      // list and keeps retrying, so a sign-in from there returns to it.
      if (returnToWorkspace()) return true;
      if (WORKSPACE_PANE) { waitForPaneHost(); return false; }
      // The Settings window still opens; its device list shows what failed.
      el.login.classList.add("hidden");
      el.app.classList.remove("hidden");
      openSettingsWindow();
      return false;
    }
    el.login.classList.add("hidden");
    el.app.classList.remove("hidden");
    if (returnToWorkspace()) return true;
    const workspaceQuery = new URLSearchParams(location.search);
    if (WORKSPACE_PANE) {
      try {
        const pinnedHost = workspaceQuery.get("host");
        if (!machines.some(machine => machine.id === pinnedHost)) throw new Error("workspace_host_missing");
        selectedId = pinnedHost;
        applyApiBase();
        el.viewList.classList.add("hidden");
        el.viewChat.classList.remove("hidden");
        // New session in the Workspace asks an agent that is not signed in yet
        // to sign in here, with that agent's own command in its terminal.
        const signInAgent = PAGE_QUERY.get("signin");
        if (signInAgent !== null) {
          if (!/^[a-z0-9-]{1,40}$/.test(signInAgent)) throw new Error("workspace_entry_not_found");
          showChatEmpty(); el.chatEmpty.textContent = "";
          await openAgentTerminal({ agentId: signInAgent, action: "login" });
          return true;
        }
        const entry = await api(`/api/workspace/entry?key=${encodeURIComponent(workspaceQuery.get("entry") || "")}`);
        const record = entry.record;
        if (record.agentId === "pi") {
          if (record.file) await openExisting(record);
          else if (record.live) {
            currentSessionCwd = record.cwd; setChatTitle(record.name || "Pi"); setChatAgent("pi"); hideChatEmpty();
            await connectRpc(null, viewGeneration, record.live, apiBase);
          } else {
            setChatTitle(record.name || "Pi"); el.chatEmpty.textContent = tKey("workspace.sessionUnavailable");
          }
        } else await openAgentTaskFromHub(record);
      } catch (error) {
        if (paneHostUnreachable(error)) { waitForPaneHost(); return false; }
        el.viewList.classList.add("hidden"); el.viewChat.classList.remove("hidden");
        showChatEmpty();
        el.chatEmpty.textContent = paneOpenErrorText(error);
      }
      return true;
    }
    if (SETTINGS_WINDOW) { openSettingsWindow(); return true; }
    location.replace("/workspace.html");
    return true;
  })().finally(() => { enterAppRequest = null; });
  return enterAppRequest;
}

function openSettingsWindow() {
  const section = PAGE_QUERY.get("section");
  if (section && Object.hasOwn(SETTINGS_TARGET_CATEGORIES, section)) openSettingsSection(section, { root: true });
  else { showSettings(); syncSettingsNav({ root: true }); }
  loadVersion();
}

el.machineCatalogRetry?.addEventListener("click", () => { void enterApp().catch(() => {}); });

function loadVersion() {
  const generation = viewGeneration;
  const baseAtStart = apiBase;
  api("/api/version").then(v => {
    if (generation !== viewGeneration || baseAtStart !== apiBase) return;
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
  syncHistoryLink();
}

function switchMachine(id, silent) {
  // A pane belongs to one computer; the Workspace picks it.
  if (WORKSPACE_PANE || !machines.some(m => m.id === id)) return;
  resetAgentHub();
  // Detach only: a sign-in left running on the old host (a device code being
  // approved on a phone, say) keeps going, and /login there attaches to it.
  closeAgentTerminal({ silent: true, detach: true });
  if ($("opencode-connection")) $("opencode-connection").open = false;
  clearDraftScopeForDeviceSwitch();
  resetProjectChanges();
  stopUpdateCenterPolling();
  cancelProjectFolderRequest();
  const generation = ++viewGeneration;
  const wasChatOpen = !el.viewChat.classList.contains("hidden");
  const preserveRunning = !!(rpc && (rpc.streaming || rpc.connectionLost));
  closeChat(preserveRunning); // 切機器時不殺正在執行的工作，閒置 RPC 則正常關閉
  el.viewChat.classList.add("hidden");
  el.viewChat.style.transform = "";
  // The Settings window stays open and shows the chosen device's settings.
  if (!SETTINGS_WINDOW) {
    resetSettingsOverlay();
    el.viewSettings.classList.add("hidden");
    el.viewModelSettings.classList.add("hidden");
  }
  selectedId = id;
  resetIncomingGrants();
  saveSelected(id);
  // Do not let a previous host's home remain authoritative while the new
  // /api/machine response is in flight. The picker still starts no-path.
  window._piHome = "";
  updateStatusData = updateDeviceStatuses.get(id)?.data || null;
  harnessUpdateRequest += 1;
  harnessUpdateController?.abort();
  harnessUpdateController = null;
  applyApiBase();
  modelCatalog = [];
  modelCatalogSources.clear();
  configuredProviders = [];
  modelCatalogMachine = null;
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
  renderMachineSwitch();
  showChatEmpty();
  void generation;
  void loadAgentCatalog();
  void refreshMachineStatuses();
  loadVersion();
  if (!silent) toast(`已切換到 ${machineName(id)}`);
  void wasChatOpen;
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

// The session list is the Workspace sidebar. Leaving a conversation in a pane
// empties the pane; any other page goes to the Workspace.
function showList() {
  saveActiveDraft();
  resetProjectChanges();
  currentSessionCwd = null;
  stopUpdateCenterPolling();
  ++viewGeneration;
  const wasStreaming = !!(rpc && (rpc.streaming || rpc.connectionLost));
  closeChat(wasStreaming); // streaming 中保留進程繼續跑；閒置對話離開時關閉
  showChatEmpty();
  el.viewChat.style.transform = "";
  resetSettingsOverlay();
  el.viewSettings.classList.add("hidden");
  el.viewModelSettings.classList.add("hidden");
  if (WORKSPACE_PANE) el.viewChat.classList.remove("hidden");
  else location.replace("/workspace.html");
  return Promise.resolve();
}
// Back from a conversation. A Workspace pane has no list of its own: its list
// is the Workspace sidebar, so it asks for that and keeps its conversation.
function goBackToList() {
  if (WORKSPACE_PANE) { parent.postMessage({ type: "workspace-show-list" }, location.origin); return; }
  showList();
}
el.btnBack.addEventListener("click", goBackToList);

function showChatEmpty() {
  setChatAgent(null);
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
  if (SETTINGS_WINDOW) location.replace("/workspace.html");
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
  // Phones open on the section list; wide layouts keep the last section.
  settingsCategory = null;
  if (el.setDesignTheme) el.setDesignTheme.hidden = true;
  el.viewModelSettings.classList.add("hidden");
  // Render after the settings view is visible so remote trust/status loaders
  // are not discarded by their visibility guard on the first open.
  el.viewSettings.classList.remove("hidden");
  renderSettings();
  void loadModelVisibility();
  void loadQuotaSources();
  el.viewSettings.classList.add("slide-in");
  settingsSlideTimer = setTimeout(() => {
    settingsSlideTimer = null;
    el.viewSettings.classList.remove("slide-in");
  }, 250);
  startUpdateCenterPolling();
}
el.btnOpenSettings.addEventListener("click", () => { showSettings(); syncSettingsNav(); });

// Settings is grouped into a few sections. Phones show the section list first
// and one section at a time; wide layouts keep the list beside the section.
const SETTINGS_CATEGORIES = Object.freeze(["appearance", "notifications", "agents", "devices", "updates", "about"]);
const SETTINGS_CATEGORY_LABELS = Object.freeze({
  appearance: "Appearance", agents: "Agents & models", devices: "Devices & access", updates: "Updates", about: "About",
});
// Titles the phrase dictionary does not carry use keyed translations.
const SETTINGS_CATEGORY_KEYS = Object.freeze({ notifications: "settings.notificationsTitle" });
const SETTINGS_TARGET_CATEGORIES = Object.freeze({
  devices: "devices", tokens: "devices", connection: "agents", "quota-sources": "agents",
  appearance: "appearance", notifications: "notifications", updates: "updates", about: "about",
});
function settingsCategoryLabel(category) {
  if (!category) return "";
  return SETTINGS_CATEGORY_KEYS[category] ? tKey(SETTINGS_CATEGORY_KEYS[category]) : updateText(SETTINGS_CATEGORY_LABELS[category]);
}
const settingsSplitQuery = window.matchMedia?.("(min-width: 900px)") || null;
let settingsCategory = null;
let lastSettingsCategory = "appearance";

function settingsSplitLayout() { return !!settingsSplitQuery?.matches; }
function activeSettingsCategory() { return settingsCategory || (settingsSplitLayout() ? lastSettingsCategory : null); }

function applySettingsCategory() {
  if (!el.viewSettings) return;
  const category = activeSettingsCategory();
  const split = settingsSplitLayout();
  el.viewSettings.dataset.settingsView = category || "home";
  const label = settingsCategoryLabel(category);
  if (el.settingsTitle) el.settingsTitle.textContent = category && !split ? label : updateText("Settings");
  if (el.settingsContentTitle) el.settingsContentTitle.textContent = label;
  for (const item of el.settingsNav?.querySelectorAll(".settings-nav-item") || []) {
    const active = item.dataset.settingsOpen === category;
    item.classList.toggle("is-active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
  const back = updateText(category && !split ? "Back to settings" : "Back");
  el.btnSettingsBack?.setAttribute("aria-label", back);
  el.btnSettingsBack?.setAttribute("title", back);
}

function showSettingsCategory(category) {
  settingsCategory = SETTINGS_CATEGORIES.includes(category) ? category : null;
  if (settingsCategory) lastSettingsCategory = settingsCategory;
  applySettingsCategory();
  const scroll = el.viewSettings?.querySelector(".settings-scroll");
  if (scroll) scroll.scrollTop = 0;
  if (activeSettingsCategory() === "updates") maybeAutoCheckHarnesses();
}

// The toolbar back button and the edge gesture leave a section first on
// phones, then close Settings.
function settingsGoBack() {
  settingsNavBack(() => {
    if (settingsCategory && !settingsSplitLayout()) { showSettingsCategory(null); return; }
    hideSettings();
  });
}

el.btnSettingsBack.addEventListener("click", settingsGoBack);
el.settingsNav?.addEventListener("click", (event) => {
  const target = event.target.closest?.("[data-settings-open]");
  if (!target) return;
  showSettingsCategory(target.dataset.settingsOpen);
  syncSettingsNav();
});

// ---- Settings levels as history entries ----
// On a phone, Settings, a section, Models & providers and one agent's page are
// stacked levels. Each level gets a history entry, so Safari's edge swipe,
// Android's back gesture, the toolbar back button and the in-app swipe all
// leave one level at a time. Only the top window owns history: a Workspace
// pane is an iframe and must not add entries to the Workspace's history.
const SETTINGS_NAV_KEY = "stepsembleSettingsNav";
let settingsNavRestoring = false;
function settingsHistoryEnabled() {
  try { return window.top === window && typeof history.pushState === "function"; } catch { return false; }
}
function settingsNavState() {
  const value = history.state?.[SETTINGS_NAV_KEY];
  return value && typeof value.level === "string" ? value : null;
}
function settingsNavLevel() {
  if (!el.viewModelSettings.classList.contains("hidden")) return modelSettingsAgent ? "models:" + modelSettingsAgent : "models";
  if (!el.viewSettings.classList.contains("hidden")) return settingsCategory && !settingsSplitLayout() ? "settings:" + settingsCategory : "settings";
  return null;
}
function settingsNavPath(level) {
  if (!level) return [];
  const path = ["settings"];
  if (level.startsWith("settings:")) path.push(level);
  if (level.startsWith("models")) {
    // Models & providers is opened from the Agents section.
    if (!settingsSplitLayout()) path.push("settings:agents");
    path.push("models");
    if (level !== "models") path.push(level);
  }
  return path;
}
// After moving forward, add entries for the levels between the current
// history entry and the one now on screen. `root` turns the page's own entry
// into the first level, for Settings opened as its own page from the Workspace.
function syncSettingsNav({ root = false } = {}) {
  if (!settingsHistoryEnabled() || settingsNavRestoring) return;
  const path = settingsNavPath(settingsNavLevel());
  if (!path.length) return;
  let start;
  if (root) {
    history.replaceState({ ...(history.state || {}), [SETTINGS_NAV_KEY]: { level: path[0], root: true } }, "");
    start = 1;
  } else {
    const current = settingsNavState()?.level;
    const index = current ? path.indexOf(current) : -1;
    if (current && index < 0) return; // Out of step with the history; leave it alone.
    start = index + 1;
  }
  for (const level of path.slice(start)) history.pushState({ [SETTINGS_NAV_KEY]: { level, pushed: true } }, "");
}
// Leave one level. A level with its own history entry goes back through the
// history so the browser and the app stay in step; anything else uses `fallback`.
function settingsNavBack(fallback) {
  const state = settingsNavState();
  if (settingsHistoryEnabled() && state?.pushed && state.level === settingsNavLevel()) { history.back(); return; }
  fallback();
}
function applySettingsNavLevel(level) {
  if (!level) { hideSettings(); return; }
  if (level.startsWith("models")) {
    const agent = level.startsWith("models:") ? level.slice(7) : null;
    if (el.viewModelSettings.classList.contains("hidden")) showModelSettings({ agent, sync: false });
    else setModelSettingsAgent(agent, { sync: false });
    return;
  }
  if (!el.viewModelSettings.classList.contains("hidden")) leaveModelSettings();
  else if (el.viewSettings.classList.contains("hidden")) showSettings();
  showSettingsCategory(level.startsWith("settings:") ? level.slice(9) : null);
}
window.addEventListener("popstate", (event) => {
  if (!settingsNavLevel()) return; // Settings is closed; nothing of ours to unwind.
  settingsNavRestoring = true;
  try { applySettingsNavLevel(event.state?.[SETTINGS_NAV_KEY]?.level || null); }
  finally { settingsNavRestoring = false; }
});
settingsSplitQuery?.addEventListener?.("change", () => { if (updateViewIsOpen()) applySettingsCategory(); });
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
function showModelSettings({ agent = null, sync = true } = {}) {
  stopUpdateCenterPolling();
  el.viewSettings.classList.add("hidden");
  el.viewModelSettings.classList.remove("hidden");
  el.viewModelSettings.classList.add("slide-in");
  setTimeout(() => el.viewModelSettings.classList.remove("slide-in"), 250);
  setModelSettingsAgent(agent, { sync: false });
  if (sync) syncSettingsNav();
}
el.modelSettingsOpen?.addEventListener("click", () => showModelSettings());
function leaveModelSettings() {
  el.viewModelSettings.classList.add("hidden");
  el.viewSettings.classList.remove("hidden");
  renderSettings();
  startUpdateCenterPolling();
}
// An agent's page returns to the agent list; the list returns to the Agents
// section it was opened from.
el.btnModelSettingsBack?.addEventListener("click", () => settingsNavBack(() => {
  if (modelSettingsAgent) { setModelSettingsAgent(null, { sync: false }); return; }
  leaveModelSettings();
  showSettingsCategory("agents");
}));

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
  history: "History",
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
    expand: "Show active tasks",
    collapse: "Hide active tasks",
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
    taskReadOnly: "This native history is read-only.",
    historyPartial: "Some very large records are omitted; the source file was not changed.",
    taskNoOutput: "No output yet",
    taskLastActivity: "Updated {value}",
    reconnectingNote: "Reconnecting to the supervisor…",
    activeSummary: "{active} active · {ready} ready",
    readySummary: "{ready} agents ready",
    noTasks: "No active tasks — choose an Agent when you start a project.",
    notInstalled: "not installed",
    isolated: "Isolated worktree",
    piNote: "Pi Agent keeps native session history. CLI agents keep bounded canonical run history and terminal output; full native transcript depends on the harness.",
    cliNote: "This CLI streams terminal output and keeps a bounded canonical run; the task keeps running when you leave the chat.",
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
    history: "History",
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

function normalizedTimestampMs(value) {
  return window.stepsembleSessionUtils?.normalizeTimestampMs?.(value) || 0;
}

function agentTaskCanStop(task) {
  // Read-only native history rows are observations of work owned by the
  // vendor client. Showing a Stop button for them creates a guaranteed 409
  // and makes the task center look unreliable.
  if (task?.nativeHistoryReadonly === true || task?.readOnly === true
    || task?.nativeCodex === true && task?.nativeCodexMutation !== true && task?.readOnly !== false) return false;
  // An idle native OpenCode session is a stored conversation. Its server
  // rejects an abort, so a Stop button here could only ever fail.
  if (task?.idleNativeSession === true && !agentTaskIsRunning(task)) return false;
  return true;
}

function agentTaskElapsed(task) {
  const start = normalizedTimestampMs(task?.startedAt);
  if (!Number.isFinite(start) || start <= 0) return "";
  const end = agentTaskIsRunning(task) ? Date.now() : normalizedTimestampMs(task?.endedAt) || Date.now();
  return runElapsedText(Math.max(0, end - start));
}

function renderAgentHubDisclosure() {
  if (!el.agentHubCard) return;
  const collapsed = settings.agentHubCollapsed !== false;
  el.agentHubCard.classList.toggle("is-collapsed", collapsed);
  if (el.agentHubBody) el.agentHubBody.hidden = collapsed;
  if (!el.agentHubToggle) return;
  const label = agentHubText(collapsed ? "expand" : "collapse");
  el.agentHubToggle.setAttribute("aria-expanded", String(!collapsed));
  el.agentHubToggle.setAttribute("aria-label", label);
  el.agentHubToggle.setAttribute("title", label);
  const use = el.agentHubToggle.querySelector("use");
  if (use) use.setAttribute("href", collapsed ? "#i-chevron-right" : "#i-chevron-down");
}

function toggleAgentHub() {
  const collapsed = settings.agentHubCollapsed !== false;
  settings = saveSettings({ agentHubCollapsed: !collapsed });
  renderAgentHubDisclosure();
}

function renderAgentHub() {
  if (!el.agentHubCard) return;
  const connectors = Array.isArray(agentCatalog) ? agentCatalog : [];
  const ready = connectors.filter((item) => item.installed).length;
  const active = agentTasks.filter(agentTaskIsRunning).length;
  // An active task makes the preview a real live surface. Mark that state on
  // the card so CSS can reserve a bounded box even while rows are being
  // inserted asynchronously; the task list then owns the inner scroll.
  el.agentHubCard.classList.toggle("has-active-tasks", active > 0);
  renderAgentHubDisclosure();
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
    // The home card is a compact status preview. Show installed connectors
    // only (and cap the row) so optional integrations cannot push Sessions
    // below the fold; New Project still exposes the complete catalog.
    const installedConnectors = connectors.filter((item) => item.installed);
    const visibleConnectors = installedConnectors.slice(0, 6);
    for (const connector of visibleConnectors) {
      const chip = document.createElement("span");
      chip.className = "agent-connector-chip installed";
      chip.title = `${connector.description || connector.label}${connector.maturity && connector.maturity !== "full" ? ` · ${connector.maturity}` : ""}`;
      const dot = document.createElement("span");
      dot.className = "dot";
      dot.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = connector.label || connector.id;
      label.dataset.i18nIgnore = "";
      chip.append(dot, StepsembleAgentIdentity.create(document, connector.id, true), label);
      el.agentHubConnectors.appendChild(chip);
    }
    const hiddenCount = Math.max(0, connectors.length - visibleConnectors.length);
    if (hiddenCount) {
      const more = document.createElement("span");
      more.className = "agent-connector-chip more";
      more.textContent = `+${hiddenCount}`;
      more.title = agentHubText("viewAll");
      el.agentHubConnectors.appendChild(more);
    }
  }
  if (!el.agentTaskList) return;
  el.agentTaskList.replaceChildren();
  const orderedTasks = [...agentTasks].sort((a, b) => {
    const activeOrder = Number(agentTaskIsRunning(b)) - Number(agentTaskIsRunning(a));
    return activeOrder || normalizedTimestampMs(b.lastActivityAt || b.startedAt) - normalizedTimestampMs(a.lastActivityAt || a.startedAt);
  });
  // Agent Hub is a live preview, not the complete conversation index. Keep
  // historical native rows out of the way when a connector exposes many
  // sessions; the All conversations sheet remains the exhaustive view.
  const previewLimit = orderedTasks.some(agentTaskIsRunning) ? 3 : 1;
  // Historical observations belong in Sessions/All conversations. They must
  // never occupy the compact live Agent Hub preview when no task is running.
  const hubTasks = orderedTasks.filter(task => agentTaskIsRunning(task)
    || task?.nativeHistoryReadonly !== true && task?.idleNativeSession !== true);
  const visible = hubTasks.slice(0, previewLimit);
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
    const logo = StepsembleAgentIdentity.create(document, task.agentId, true);
    logo.appendChild(dot);
    row.append(logo, copy, state);
    row.addEventListener("click", () => openAgentTaskFromHub(task));
    el.agentTaskList.appendChild(row);
  }
}

function agentTaskCenterFilterMatches(task, filter) {
  const status = String(task?.status || "");
  if (filter === "active") {
    if (agentTaskIsRunning(task)) return true;
    // A stored native conversation is not pending work, so it must not inflate
    // the active count even though its native status reads as idle/waiting.
    return task?.nativeHistoryReadonly !== true && task?.idleNativeSession !== true && status === "waiting";
  }
  if (filter === "all" || !filter) return true;
  return status === filter;
}

function agentTaskCenterSort(a, b) {
  const activeOrder = Number(agentTaskIsRunning(b)) - Number(agentTaskIsRunning(a));
  return activeOrder || normalizedTimestampMs(b.lastActivityAt || b.startedAt) - normalizedTimestampMs(a.lastActivityAt || a.startedAt);
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
    name.className = "agent-task-center-name";
    const meta = document.createElement("span");
    meta.className = "agent-task-center-meta";
    const elapsed = agentTaskElapsed(task);
    meta.textContent = `${agentConnectorLabel(task.agentId)} · ${agentStatusText(task.status)}${elapsed ? ` · ${elapsed}` : ""}`;
    meta.dataset.i18nIgnore = "";
    const pathLabel = document.createElement("small");
    pathLabel.className = "agent-task-center-path";
    pathLabel.textContent = task.cwd || task.worktree?.path || "—";
    if (task.cwd || task.worktree?.path) pathLabel.title = task.cwd || task.worktree.path;
    pathLabel.dataset.i18nIgnore = "";
    const preview = document.createElement("small");
    preview.className = "agent-task-center-preview";
    const outputLine = stripAnsi(String(task.outputTail || "")).trim().split(/\r?\n/).filter(Boolean).pop();
    if (outputLine) {
      preview.textContent = outputLine;
      preview.dataset.i18nIgnore = "";
      preview.title = outputLine;
      copy.append(name, meta, pathLabel, preview);
    } else {
      // Empty output is not actionable information in a dense task inbox.
      // Keep the task state in the meta line and avoid spending a full row on
      // a repeated “No output yet” label for every waiting task.
      copy.append(name, meta, pathLabel);
    }
    open.appendChild(copy);
    const taskLabel = name.textContent || agentHubText("agentTask");
    open.setAttribute("aria-label", `${taskLabel} · ${agentConnectorLabel(task.agentId)} · ${agentStatusText(task.status)}`);

    const actions = document.createElement("span");
    actions.className = "agent-task-center-actions";
    const activity = document.createElement("small");
    activity.className = "agent-task-center-activity";
    activity.dataset.role = "activity";
    const activityAt = normalizedTimestampMs(task.lastActivityAt);
    const activityLabel = activityAt ? agentHubText("taskLastActivity", { value: fmtTime(activityAt) }) : "";
    activity.textContent = activityAt ? fmtTime(activityAt) : "";
    if (activityLabel) {
      activity.title = activityLabel;
      activity.setAttribute("aria-label", activityLabel);
    }
    actions.appendChild(activity);
    if (agentTaskCanStop(task) && (agentTaskIsRunning(task) || task.status === "waiting")) {
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "agent-task-center-stop btn ghost";
      stop.textContent = agentHubText("taskStop");
      stop.setAttribute("aria-label", `${agentHubText("taskStop")} · ${taskLabel}`);
      stop.addEventListener("click", (event) => {
        event.stopPropagation();
        void stopAgentTaskFromCenter(task, stop);
      });
      actions.appendChild(stop);
    }
    const logo = StepsembleAgentIdentity.create(document, task.agentId, true);
    logo.appendChild(dot);
    row.append(logo, open, actions);
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
  const groups = new Map();
  for (const connector of connectors) {
    const key = connector.category === "personal" ? "personal" : "coding";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(connector);
  }
  for (const [key, rows] of groups) {
    const target = groups.size > 1 ? document.createElement("optgroup") : el.newAgent;
    if (target !== el.newAgent) target.label = key === "personal" ? "Personal agents" : "Coding agents";
    for (const connector of rows) {
      const option = document.createElement("option");
      option.value = connector.id;
      const maturity = connector.maturity && connector.maturity !== "full" ? ` · ${connector.maturity}` : "";
      option.textContent = connector.installed ? `${connector.label}${maturity}` : `${connector.label} · ${agentHubText("notInstalled")}`;
      option.disabled = connector.installed !== true;
      option.dataset.i18nIgnore = "";
      target.appendChild(option);
    }
    if (target !== el.newAgent) el.newAgent.appendChild(target);
  }
  const selected = [...el.newAgent.options].find((option) => option.value === previous && !option.disabled)
    || [...el.newAgent.options].find((option) => option.value === "pi" && !option.disabled)
    || [...el.newAgent.options].find((option) => !option.disabled);
  if (selected) el.newAgent.value = selected.value;
  updateNewAgentNote();
}

const PRIMARY_AGENT_FEATURES = Object.freeze(["followUp", "model", "reasoning", "images", "approval", "recovery", "history", "context"]);

function agentCapabilityReason(reason) {
  if (!reason) return "";
  const key = `agentCapability.reason.${reason}`;
  const translated = tKey(key);
  if (translated !== key) return translated;
  return String(reason).replaceAll("_", " ");
}

function renderNewAgentCapabilities(connector, unavailable = false) {
  if (!el.newAgentCapabilities) return;
  el.newAgentCapabilities.replaceChildren();
  if (unavailable || !connector?.featureContract?.features) {
    el.newAgentCapabilities.hidden = true;
    return;
  }
  el.newAgentCapabilities.hidden = false;
  el.newAgentCapabilities.dataset.contractVersion = String(connector.featureContract.version || "");
  for (const featureId of PRIMARY_AGENT_FEATURES) {
    const feature = connector.featureContract.features[featureId];
    if (!feature) continue;
    const chip = document.createElement("span");
    const status = ["ready", "limited", "unavailable", "unknown"].includes(feature.status) ? feature.status : "unknown";
    chip.className = `agent-capability-chip ${status}`;
    chip.dataset.feature = featureId;
    chip.dataset.status = status;
    const label = tKey(`agentCapability.feature.${featureId}`);
    const statusLabel = tKey(`agentCapability.status.${status}`);
    chip.textContent = `${label} · ${statusLabel}`;
    chip.title = feature.reason
      ? `${label}: ${statusLabel} · ${agentCapabilityReason(feature.reason)}`
      : `${label}: ${statusLabel}`;
    el.newAgentCapabilities.appendChild(chip);
  }
}

function updateNewAgentNote() {
  const id = el.newAgent?.value;
  const connector = agentCatalog.find((item) => item.id === id);
  const unavailable = agentCatalogError || connector?.installed !== true;
  const folderUnavailable = el.newCwd ? !el.newCwd.value.trim() : false;
  if (el.newStart) el.newStart.disabled = unavailable || folderUnavailable || newAgentStartPending;
  if (el.newAgentNote) {
    if (unavailable) el.newAgentNote.textContent = agentHubText(agentCatalogError ? "unavailable" : "discovering");
    else if (id === "pi") el.newAgentNote.textContent = agentHubText("piNote");
    else if (connector?.history?.history === "native_readonly") el.newAgentNote.textContent = `${connector.description || agentHubText("cliNote")} ${agentHubText("nativeHistoryNote")}`;
    else if (connector?.history?.history === "canonical_bounded") {
      const journal = connector.history.journal === "durable_host_local"
        ? agentHubText("journalNote")
        : agentHubText("boundedNote");
      el.newAgentNote.textContent = `${connector.description || agentHubText("cliNote")} ${journal} ${agentHubText("ackNote")}`;
    }
    else el.newAgentNote.textContent = connector?.description || agentHubText("cliNote");
  }
  renderNewAgentCapabilities(connector, unavailable);
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
let runningStateRequest = null;
// The list view refreshes sessions first and then hydrates the cross-agent
// task snapshot. Keep that sequence as a promise so a row tapped immediately
// after Back can wait for the exact redraw that produced it.
let sessionListReadyPromise = Promise.resolve();
// Identity of the task rows the Sessions list is currently showing. A poll that
// returns the same rows must not rebuild the list under the user's pointer.
let lastAgentTaskListSignature = "";
let conversationView = null;
let conversationSourceState = { sessions: "loading", tasks: "loading" };
function updateConversationCatalog() {
  if (!conversationView?.isOpen()) return;
  conversationView.update(StepsembleConversations.build(lastChatMachineKey(), sessionsCache, agentTasks),
    lastChatMachineKey(), machineName(selectedId), Object.values(conversationSourceState).some(state => state !== "ready"));
}
function openConversationCatalog() {
  if (!conversationView) conversationView = StepsembleConversations.createView({ dialog: $("conversation-catalog"),
    t: (key, vars) => tKey(`conversations.${key}`, vars), title: entry => stripMd(entry.title),
    status: entry => entry.status === "history" ? tKey("conversations.saved") : entry.status === "unknown" ? tKey("conversations.unknown") : agentStatusText(entry.status),
    updated: entry => entry.updatedAt ? fmtTime(entry.updatedAt) : "",
    open(entry) {
      // Resolve the exact still-current source at click time. A stale row must
      // never fall back to a same-name conversation, another Host, or a new run.
      if (entry.hostId !== lastChatMachineKey()) return;
      const row = entry.kind === "pi_history" ? sessionsCache.find(s => s.file === entry.reference)
        : agentTasks.find(task => String(task.id || task.taskId || "") === entry.reference);
      if (!row) { toast(tKey("conversations.gone"), true); return; }
      if (entry.kind === "pi_history") void openExisting(row); else void openAgentTaskFromHub(row);
    },
    async refresh() { await Promise.all([refreshSessions({ refreshTasks: false }), refreshAgentTasks()]); updateConversationCatalog(); },
  });
  conversationView.open(); updateConversationCatalog();
  // The initial Agent Hub discovery is intentionally non-blocking. Refresh
  // here as well so opening All conversations while that request is still in
  // flight can never leave the sheet showing only the Pi snapshot.
  void refreshAgentTasks();
}
function resetAgentHub() {
  runningStateRequest?.controller.abort();
  runningStateRequest = null;
  agentCatalogRequest?.abort();
  agentTaskRefreshRequest?.abort();
  newAgentOpenRequest?.abort();
  newAgentOpenRequest = null;
  agentCatalogRequest = agentTaskRefreshRequest = null;
  agentCatalog = [];
  agentTasks = [];
  lastAgentTaskListSignature = "";
  conversationSourceState = { sessions: "loading", tasks: "loading" };
  conversationView?.reset();
  agentCatalogError = false;
  renderNewAgentOptions();
  renderAgentHub();
  renderAgentTaskCenter();
  syncAgentTaskPolling();
}

// Identity of the task rows the Sessions list renders. Elapsed time and
// last activity are excluded on purpose: they change on every poll and have
// their own ticker, so including them would rebuild the list continuously.
function agentTaskListSignature() {
  return agentTasks
    .map((task) => [task?.id || task?.taskId || "", task?.agentId || "", task?.status || "",
      task?.name || "", task?.cwd || "", task?.file || ""].join("\u0001"))
    .join("\u0002");
}

async function refreshAgentTasks() {
  if (WORKSPACE_PANE) return;
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
    conversationSourceState.tasks = "ready";
    renderAgentHub();
    renderAgentTaskCenter();
    // The main Sessions list is cross-agent too. Re-render after the task
    // snapshot arrives; the Pi history request intentionally resolves first.
    if (typeof sessionListRecords === "function") {
      if (el.sessionCount) el.sessionCount.textContent = String(sessionListRecords().length);
      // Rebuilding every row on each 5-second poll destroys the DOM node the
      // user is interacting with and costs a full sort plus re-layout on a
      // phone. Redraw only when the rows this list actually shows changed.
      const signature = agentTaskListSignature();
      if (signature !== lastAgentTaskListSignature) {
        lastAgentTaskListSignature = signature;
        if (typeof renderSessionList === "function") renderSessionList(el.search?.value || "");
      }
    }
    updateConversationCatalog();
    syncAgentTaskPolling();
    // Restore only after a successful task snapshot; doing this before the
    // first fetch would race the durable generic-task list and fall back to a
    // stale native session.
    void restoreLastChat();
  } catch (error) {
    if (isCurrent() && error?.name !== "AbortError") {
      conversationSourceState.tasks = "stale";
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

// Returning from a conversation starts a session-list refresh and, in turn,
// an Agent Hub refresh. A row can remain visible for a few milliseconds while
// its closure still points at the previous task snapshot. Native rows must
// wait for that snapshot to settle before opening; otherwise a fast tap can
// race the redraw and leave the chat on the empty state.
async function waitForAgentTaskSnapshot(maxMs = 2500) {
  const deadline = Date.now() + Math.max(0, Number(maxMs) || 0);
  await Promise.race([
    sessionListReadyPromise,
    new Promise(resolve => setTimeout(resolve, Math.max(0, deadline - Date.now()))),
  ]);
  // showList() starts the session snapshot first and that request starts the
  // Agent Hub snapshot only after it resolves. Waiting on both prevents a
  // fast tap from opening a row while the list is about to be replaced by
  // the just-finished refresh (the source of the empty-chat flash).
  while ((refreshRequest || agentTaskRefreshRequest) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
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
    const rawFile = task.file || task.sessionFile;
    const identity = piSessionFileIdentity(rawFile);
    const existing = sessionsCache.find(session => piSessionFileIdentity(session.file) === identity);
    const file = existing?.file || normalizePiSessionFile(rawFile);
    return openExisting(existing ||
      { file, cwd: task.cwd || "", name: task.sessionName || null, firstMessage: task.firstMessage });
  }
  // OpenCode history also carries the generic `nativeHistoryReadonly` marker
  // so it stays out of the live task preview. Route it by connector first;
  // otherwise it would fall into the Claude/Codex transcript reader, which
  // intentionally accepts only claude-history:/codex-history: IDs and leaves
  // the chat on the empty state when the same row is opened again.
  if (task.nativeOpenCode === true || task.agentId === "opencode") return openOpenCodeNativeTask(task);
  if (task.nativeHistoryReadonly === true) return openNativeHistoryTask(task);
  if (task.nativeCodex === true || task.nativeThreadId && task.agentId === "codex") return openCodexNativeTask(task);
  if (task.nativeGrokAcp === true || task.nativeSessionId && task.agentId === "grok-build") return openGrokAcpTask(task);
  if (task.nativeAcp === true || task.nativeSessionId && ["cline", "kilo", "hermes"].includes(task.agentId)) return openAgentClientProtocolTask(task);
  if (task.nativeClaudeStructured === true || task.nativeSessionId && task.agentId === "claude-code") return openClaudeStructuredTask(task);
  if (task.nativeAntigravityStructured === true || task.nativeSessionId && task.agentId === "antigravity") return openAntigravityStructuredTask(task);
  if (task.nativeOpenCode === true || task.nativeSessionId) return openOpenCodeNativeTask(task);
  return openGenericTask(task);
}

function appendNativeHistoryMessage(message, agentId, container = el.messages) {
  const role = message?.role === "user" ? "user" : "assistant";
  const label = agentId === "claude-code" ? "Claude Code" : "Codex";
  const { wrap, bubble } = makeMsgShell(role, role === "user" ? "你" : label, container);
  stampMessageTime(wrap, message?.ts || message?.timestamp);
  const value = boundedDisplayText(message?.text || "", 512 * 1024);
  if (value) bubble.appendChild(renderMarkdown(value));
  if (role === "assistant") wrap.appendChild(msgActionsRow("assistant", () => value));
}

function boundedDisplayText(value, limit) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, limit);
}

async function openNativeHistoryTask(task, generationOverride = null) {
  if (!task || task.nativeHistoryReadonly !== true) return;
  const taskId = String(task.id || task.taskId || "");
  if (!/^(?:claude-history|codex-history):[a-f0-9-]{36}$/i.test(taskId)) return;
  const agentId = task.agentId === "claude-code" ? "claude-code" : "codex";
  const name = task.name || (agentId === "claude-code" ? "Claude Code" : "Codex");
  const cwd = task.cwd || "";
  rememberLastAgentTask(taskId);
  beginDraftScope({ cwd, name });
  const generation = generationOverride === null ? ++viewGeneration : generationOverride;
  if (rpc) closeChat(true);
  resetTaskProgress(); resetProjectChanges(); resetComposerSummary();
  currentSessionFile = null; currentAgentTaskId = taskId; updateSessionSelection();
  _lastMsgDate = null; lastUserText = ""; currentSessionCwd = cwd;
  historyState = null; removeHistoryLoadButton(); removeCodexNativeHistoryButton();
  autoScrollPinned = true; hideChatEmpty(); setChatTitle(name); setChatAgent(agentId);
  el.chatSub.dataset.base = cwd; el.chatSub.textContent = cwd; resetLiveUsage(); el.messages.innerHTML = "";
  resetSessionUsage(); ensureSessionUsageFooter();
  if (!isDesktop()) { el.viewList.classList.add("hidden"); syncSessionListPolling(); }
  el.viewChat.classList.remove("hidden");
  void refreshProjectChanges({ background: true });
  rpc = { sid: taskId, generic: true, nativeHistoryReadonly: true, readOnly: true, nativeHistoryProvider: agentId,
    nativeHistoryRequest: null, nativeLoading: true, connectionLost: false, stopPending: false, streamReady: true,
    taskStatus: "history", genericOutputNode: null, genericTerminalNotice: null, agentId, agentLabel: agentConnectorLabel(agentId),
    name, cwd, runStartedAt: normalizedTimestampMs(task.startedAt) || null, runEndedAt: normalizedTimestampMs(task.endedAt) || null };
  const connection = rpc;
  syncGenericInputState();
  try {
    const result = await api(`/api/native-history/session?taskId=${encodeURIComponent(taskId)}`);
    if (rpc !== connection || generation !== viewGeneration) return;
    if (!Array.isArray(result?.messages)) throw new Error("history_session_invalid");
    const staging = document.createElement("div");
    let sliceStarted = performance.now();
    for (const message of result.messages) {
      if (performance.now() - sliceStarted > 8) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (rpc !== connection || generation !== viewGeneration) return;
        sliceStarted = performance.now();
      }
      maybeDateSeparator(message.ts || message.timestamp, staging);
      appendNativeHistoryMessage(message, agentId, staging);
    }
    const fragment = document.createDocumentFragment();
    while (staging.firstChild) fragment.appendChild(staging.firstChild);
    el.messages.appendChild(fragment);
    const note = el.taskReplayNote;
    if (note) {
      if (result.truncated) note.removeAttribute("data-i18n-key");
      else note.dataset.i18nKey = "agentHub.taskReadOnly";
      note.textContent = result.truncated ? `${agentHubText("taskReadOnly")} ${agentHubText("historyPartial")}` : agentHubText("taskReadOnly");
      note.classList.remove("hidden");
    }
    keepSessionUsageAtEnd(); scrollBottom(true);
    connection.nativeLoading = false; connection.connectionLost = false;
    applyGenericTaskSnapshot({ id: taskId, taskId, agentId, status: "history", nativeHistoryReadonly: true, readOnly: true,
      name, cwd, startedAt: normalizedTimestampMs(task.startedAt), lastActivityAt: normalizedTimestampMs(task.lastActivityAt) });
    syncGenericInputState();
  } catch (error) {
    if (rpc !== connection || generation !== viewGeneration) return;
    connection.nativeLoading = false; connection.connectionLost = true; syncGenericInputState();
    toast(tKey("runtime.historyFailed", { detail: String(error?.message || "history unavailable").slice(0, 128) }), true);
  }
}

el.agentHubToggle?.addEventListener("click", toggleAgentHub);
el.agentHubRefresh?.addEventListener("click", () => { void loadAgentCatalog(); void refreshAgentTasks(); });
el.agentHubOpenCenter?.addEventListener("click", openAgentTaskCenter);
function syncHistoryLink() {
  // A normal link supports keyboard/context-menu navigation without a script
  // popup. Only the saved machine ID crosses into the separate history tab.
  const link = $("agent-hub-history"); if (!link) return;
  const match = /^\/r\/([a-z0-9-]{1,48})$/.exec(apiBase);
  if (apiBase && !match) { link.removeAttribute("href"); link.setAttribute("aria-disabled", "true"); return; }
  link.removeAttribute("aria-disabled");
  link.href = `/history.html${match ? `?machine=${encodeURIComponent(match[1])}` : ""}`;
}

let openCodeConnectionSequence = 0;
async function refreshOpenCodeConnection(start = false) {
  const status = $("opencode-connection-status"), button = $("opencode-connection-start"), refresh = $("opencode-connection-refresh");
  if (!status || !button || !refresh) return;
  if (start && !window.confirm(browseText("Enable a password-protected OpenCode service on the selected computer?"))) return;
  const sequence = ++openCodeConnectionSequence, base = apiBase;
  const current = () => sequence === openCodeConnectionSequence && base === apiBase;
  button.disabled = true; refresh.disabled = true;
  status.textContent = browseText(start ? "Starting local OpenCode…" : "Checking connection…");
  try {
    const result = start ? await post("/api/opencode/native/setup", { confirm: true }) : await api("/api/opencode/native");
    if (!current()) return;
    const ready = result?.adapter?.ready === true;
    status.textContent = browseText(ready ? "OpenCode native connection is ready." : "OpenCode is not connected. Enable the local service or check your configured server.");
    button.disabled = ready;
    if (ready) { void loadAgentCatalog(); void refreshAgentTasks(); }
  } catch (error) {
    if (!current()) return;
    status.textContent = `${browseText("OpenCode connection could not be started.")} ${String(error?.message || "").slice(0, 128)}`;
    button.disabled = false;
  } finally { if (current()) refresh.disabled = false; }
}
$("opencode-connection")?.addEventListener("toggle", () => {
  if ($("opencode-connection").open) void refreshOpenCodeConnection();
});
$("opencode-connection-refresh")?.addEventListener("click", () => void refreshOpenCodeConnection());
$("opencode-connection-start")?.addEventListener("click", () => void refreshOpenCodeConnection(true));
el.agentTaskCenterClose?.addEventListener("click", closeAgentTaskCenter);
el.agentTaskCenter?.addEventListener("click", (event) => { if (event.target === el.agentTaskCenter) closeAgentTaskCenter(); });
el.agentTaskCenterSearch?.addEventListener("input", renderAgentTaskCenter);
el.agentTaskCenterFilter?.addEventListener("change", renderAgentTaskCenter);
el.newAgent?.addEventListener("change", updateNewAgentNote);

async function refreshSessions({ refreshTasks = true } = {}) {
  if (WORKSPACE_PANE) { parent.postMessage({ type: "workspace-refresh" }, location.origin); return; }
  const generation = viewGeneration;
  const baseAtStart = apiBase;
  const sequence = ++refreshSequence;
  if (refreshRequest) refreshRequest.abort();
  refreshRequest = new AbortController();
  try {
    const includeTemporary = settings.showTemporarySessions ? "1" : "0";
    const data = await api(`/api/sessions?includeTemporary=${includeTemporary}`, { signal: refreshRequest.signal });
    if (sequence !== refreshSequence || generation !== viewGeneration || baseAtStart !== apiBase) return;
    if (!Array.isArray(data?.sessions)) throw new Error("Invalid session snapshot");
    sessionsCache = data.sessions;
    conversationSourceState.sessions = "ready";
    const currentSummary = sessionsCache.find(session => session.file === currentSessionFile);
    if (currentSummary && !el.viewChat.classList.contains("hidden")) setChatTitle(sessionDisplayTitle(currentSummary));
    if (el.sessionCount) el.sessionCount.textContent = String(typeof sessionListRecords === "function" ? sessionListRecords().length : sessionsCache.length);
    renderSessionList(el.search.value);
    syncSessionListPolling();
    void refreshStuckSessions();
    if (refreshTasks) void refreshAgentTasks();
  } catch (e) {
    if (sequence === refreshSequence && generation === viewGeneration && baseAtStart === apiBase && e.name !== "AbortError") conversationSourceState.sessions = "stale";
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
  const base = apiBase, host = selectedId, generation = viewGeneration;
  // Slow health polling must not accumulate requests. A new Host/view may
  // replace the flight, but an old reply must never alter its running badges.
  if (runningStateRequest?.base === base && runningStateRequest.host === host && runningStateRequest.generation === generation) return;
  runningStateRequest?.controller.abort();
  const request = { base, host, generation, controller: new AbortController() };
  runningStateRequest = request;
  const current = () => runningStateRequest === request && base === apiBase && host === selectedId && generation === viewGeneration
    && !request.controller.signal.aborted && !el.viewList.classList.contains("hidden");
  try {
    const data = await api("/api/rpcs", { signal: request.controller.signal });
    if (!current() || !Array.isArray(data?.rpcs)) return;
    const live = new Map();
    for (const rpc of data.rpcs) {
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
      session.runStartedAt = normalizedTimestampMs(entry?.runStartedAt) || (now ? session.runStartedAt : null);
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
  } catch { /* transient network errors: preserve last truth; the next tick retries */ }
  finally { if (runningStateRequest === request) runningStateRequest = null; }
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
// Restore the last conversation on desktop reloads, but keep mobile launches
// on the Sessions home. A phone app is usually reopened as a task switcher
// launch, not as a deliberate request to reopen the previous conversation.
// ---------------------------------------------------------------------------

const LAST_CHAT_KEY = "stepsemble.last-chat.v1";
const LAST_AGENT_TASK_KEY = "stepsemble.last-agent-task.v1";
const LEGACY_LAST_CHAT_KEYS = Object.freeze(["piharbor.last-chat.v1", "piweb.last-chat.v1"]);
const LEGACY_LAST_AGENT_TASK_KEYS = Object.freeze(["piharbor.last-agent-task.v1", "piweb.last-agent-task.v1"]);
let lastChatRestoreAttempted = false;

function shouldRestoreLastChat() {
  try {
    const narrow = matchMedia("(max-width: 760px)").matches;
    const touch = matchMedia("(pointer: coarse)").matches || Number(navigator.maxTouchPoints) > 0;
    return !(narrow && touch);
  } catch {
    // Older embedded browsers should retain the safer desktop behaviour when
    // they cannot expose viewport or touch capability information.
    return true;
  }
}

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
  if (WORKSPACE_PANE) return;
  if (lastChatRestoreAttempted) return;
  lastChatRestoreAttempted = true;
  if (!shouldRestoreLastChat()) return;
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

// The main Sessions list is a cross-agent index. Pi history still comes from
// the history endpoint, while native/generic agent conversations come from the
// task snapshot. Keep a stable per-agent key so pins and selection never
// collide with a Pi file path or with another Host.
function sessionListTaskId(session) {
  return String(session?.id || session?.taskId || "").trim();
}

// Pi's live RPC layer sometimes reports an absolute session path while the
// history endpoint intentionally exposes a path relative to the session
// store. Treat both forms as one conversation and keep only the relative form
// for browser requests; /api/session deliberately rejects absolute paths.
function normalizePiSessionFile(file) {
  let value = String(file || "").trim().replace(/\\/g, "/");
  while (value.startsWith("./")) value = value.slice(2);
  const marker = "/.pi/agent/sessions/";
  const markerIndex = value.lastIndexOf(marker);
  if (markerIndex >= 0) {
    value = value.slice(markerIndex + marker.length);
  } else if (/^(?:\/|[a-z]:\/)/i.test(value)) {
    // PI_SESSIONS_DIR may be customized. Pi's relative catalog path retains
    // its encoded cwd directory, so recover that stable suffix without
    // exposing the host's absolute filesystem path to /api/session.
    const parts = value.split("/").filter(Boolean);
    let encodedDirectory = -1;
    for (let index = parts.length - 2; index >= 0; index--) {
      if (/^--.*--$/.test(parts[index])) { encodedDirectory = index; break; }
    }
    if (encodedDirectory >= 0) value = parts.slice(encodedDirectory).join("/");
  }
  return value;
}

function piSessionFileIdentity(file) {
  const normalized = normalizePiSessionFile(file);
  const name = normalized.split("/").filter(Boolean).pop() || "";
  const uuid = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i)?.[1];
  return uuid ? `pi:${uuid.toLowerCase()}` : normalized;
}

function sessionListIsAgentTask(session) {
  return String(session?.agentId || "pi") !== "pi";
}

function sessionListKey(session) {
  if (typeof session === "string") return session;
  if (!sessionListIsAgentTask(session)) return String(session?.file || "");
  const agentId = String(session?.agentId || "agent").trim() || "agent";
  const taskId = sessionListTaskId(session);
  return taskId ? `agent:${agentId}:${taskId}` : "";
}

function currentSessionListKey() {
  if (currentAgentTaskId) {
    const agentId = String(rpc?.agentId || currentAgentTaskId.split(":", 1)[0] || "agent");
    return sessionListKey({ agentId, id: currentAgentTaskId });
  }
  return String(currentSessionFile || "");
}

function sessionListTime(session) {
  return normalizedTimestampMs(session?.mtimeMs || session?.lastActivityAt || session?.startedAt);
}

function sessionListTitle(session) {
  if (!sessionListIsAgentTask(session)) return sessionDisplayTitle(session);
  return stripMd(session?.name || agentConnectorLabel(session?.agentId) || "Agent").replace(/[\r\n]+/g, " ") || "Agent";
}

function sessionListRecords() {
  const records = [...sessionsCache];
  const piRecords = new Map();
  for (const session of records) {
    const identity = piSessionFileIdentity(session?.file);
    if (identity) piRecords.set(identity, session);
  }
  const seenTaskIds = new Set();
  for (const task of agentTasks) {
    const taskId = sessionListTaskId(task);
    const agentId = String(task?.agentId || "pi");
    const taskIdentity = `${agentId}:${taskId}`;
    if (!taskId || seenTaskIds.has(taskIdentity)) continue;
    seenTaskIds.add(taskIdentity);
    const rawFile = String(task?.file || task?.sessionFile || "");
    if (agentId === "pi") {
      // A Pi task is already represented by its native history row. If it is
      // not there yet, keep the task visible so a just-created run is never
      // missing from the main list while the history index catches up.
      const file = normalizePiSessionFile(rawFile);
      const identity = piSessionFileIdentity(rawFile);
      const existing = identity ? piRecords.get(identity) : null;
      if (existing) {
        if (existing && agentTaskIsRunning(task)) {
          existing.isRunning = true;
          existing.runStartedAt ||= normalizedTimestampMs(task.startedAt);
        }
        continue;
      }
      if (!file) continue;
      const placeholder = { ...task, id: taskId, file, agentId: "pi" };
      records.push(placeholder);
      if (identity) piRecords.set(identity, placeholder);
      continue;
    }
    records.push({ ...task, id: taskId, taskId, agentId, __agentTask: true });
  }
  return records;
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
  const key = sessionListKey(session);
  return !!key && Array.isArray(settings.sessionPins) && settings.sessionPins.includes(key);
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
  const hasSessions = sessionListRecords().length > 0;
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
  const startedAt = normalizedTimestampMs(meta.dataset.runStartedAt);
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
  const selectedKey = typeof currentSessionListKey === "function" ? currentSessionListKey() : String(currentSessionFile || "");
  for (const row of el.sessionList.querySelectorAll(".session-item")) {
    const selected = row.dataset.sessionKey
      ? row.dataset.sessionKey === selectedKey
      : row.dataset.sessionFile === currentSessionFile;
    row.classList.toggle("selected", selected);
    const button = row.querySelector(".session-item-main");
    if (selected) button?.setAttribute("aria-current", "true");
    else button?.removeAttribute("aria-current");
  }
}

function renderSessionList(q) {
  updateNewProjectAffordance();
  const query = (q || "").trim().toLowerCase();
  const records = sessionListRecords();
  const list = records.filter(s => !query ||
    sessionListTitle(s).toLowerCase().includes(query) ||
    (s.firstMessage || "").toLowerCase().includes(query) ||
    (s.preview || "").toLowerCase().includes(query) ||
    (s.cwd || "").toLowerCase().includes(query) ||
    agentConnectorLabel(s.agentId).toLowerCase().includes(query));
  const orderedList = [...list].sort((a, b) => Number(sessionIsPinned(b)) - Number(sessionIsPinned(a)) || sessionListTime(b) - sessionListTime(a));
  const visibleList = settings.groupByProject ? orderedList : orderedList.slice(0, sessionRenderLimit);
  el.sessionList.classList.toggle("grouped", !!settings.groupByProject);
  el.sessionList.innerHTML = "";
  el.listEmpty.classList.toggle("hidden", list.length > 0);

  const makeItem = (s) => {
    const isAgentTask = sessionListIsAgentTask(s);
    const recordKey = sessionListKey(s);
    const selected = recordKey === currentSessionListKey();
    const li = document.createElement("li");
    li.className = "session-item" + (selected ? " selected" : "");
    li.dataset.sessionKey = recordKey;
    // Keep the legacy data attribute for Pi-specific automation and CSS.
    if (s.file) li.dataset.sessionFile = s.file;
    const rawName = sessionListTitle(s);
    const name = stripMd(rawName).slice(0, 70) || (window.stepsembleI18n?.t("(Untitled)") || "(Untitled)");
    const sessionAgentId = s.agentId ?? "pi";
    const mtimeMs = sessionListTime(s);
    const relative = isAgentTask
      ? window.stepsembleSessionUtils.compactRelativeTime(mtimeMs)
      : window.stepsembleSessionUtils.compactRelativeTime(s.mtimeMs);
    const when = relative || (mtimeMs ? tKey("sessions.justNow") : "");
    const usage = [
      StepsembleAgentIdentity.lookup(sessionAgentId).label,
      isAgentTask && s.status ? agentStatusText(s.status) : "",
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
    li.querySelector(".session-item-main").prepend(StepsembleAgentIdentity.create(document, sessionAgentId, true));
    const meta = li.querySelector(".s-meta");
    // A session that is still working outranks its token/cost summary: after
    // a reload this row is the only place that says the host is busy.
    const isRunning = !!s.isRunning || (isAgentTask && agentTaskIsRunning(s));
    if (isRunning) {
      li.classList.add("session-running");
      const dot = document.createElement("span");
      dot.className = "session-running-dot";
      dot.setAttribute("aria-hidden", "true");
      li.querySelector(".session-item-copy").prepend(dot);
      meta.classList.add("session-running-meta");
      meta.dataset.runStartedAt = String(normalizedTimestampMs(s.runStartedAt || s.startedAt) || "");
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
    itemActions.append(pinButton);
    const archiveButton = isAgentTask ? null : sessionIconButton("i-archive", projectActionText("Archive chats"));
    if (archiveButton) itemActions.appendChild(archiveButton);
    const stopItemAction = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    pinButton.addEventListener("click", (event) => {
      stopItemAction(event);
      const pins = new Set(settings.sessionPins || []);
      if (pins.has(recordKey)) pins.delete(recordKey);
      else pins.add(recordKey);
      settings = saveSettings({ sessionPins: [...pins] });
      closeSwipedSessionItems();
      renderSessionList(el.search.value);
    });
    if (archiveButton) archiveButton.addEventListener("click", async (event) => {
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
    if (selected) sessionMain?.setAttribute("aria-current", "true");
    const openSessionRow = () => {
      const open = async () => {
        if (!isAgentTask) return openExisting(s);
        await waitForAgentTaskSnapshot();
        // The task snapshot may have replaced this row while the user was
        // tapping. Resolve by its stable cross-agent key and only fall back
        // to the closure when the refresh did not produce a row at all.
        const fresh = sessionListRecords().find(row => sessionListKey(row) === recordKey) || s;
        return openAgentTaskFromHub(fresh);
      };
      void open();
    };
    let lpTimer = null, longPressed = false, swipeConsumed = false, touchStartX = 0, touchStartY = 0;
    if (!isAgentTask) {
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
    }
    sessionMain?.addEventListener("click", () => {
      if (swipeConsumed) {
        swipeConsumed = false;
        return;
      }
      if (li.classList.contains("swiped")) {
        li.classList.remove("swiped");
        return;
      }
      if (!longPressed) {
        openSessionRow();
      }
    });
    sessionMain?.addEventListener("keydown", (event) => {
      if ((event.key === "Enter" || event.key === " ") && !longPressed) {
        event.preventDefault();
        openSessionRow();
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
    const newest = (items) => Math.max(...items.map(sessionListTime));
    const sorted = [...groups.entries()]
      .filter(([cwd]) => !projectIsRemoved(cwd) || !!query)
      .sort((a, b) => {
        const pinOrder = Number(projectIsPinned(b[0])) - Number(projectIsPinned(a[0]));
        return pinOrder || newest(b[1]) - newest(a[1]);
    });
    for (const [cwd, items] of sorted) {
      const collapsed = collapsedProjects.has(cwd);
      const expanded = expandedProjectSessions.has(cwd);
      const orderedItems = [...items].sort((a, b) => Number(sessionIsPinned(b)) - Number(sessionIsPinned(a)) || sessionListTime(b) - sessionListTime(a));
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
$("btn-conversations")?.addEventListener("click", openConversationCatalog);
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

function setChatAgent(agentId) {
  if (!el.chatAgentLogo) return;
  el.chatAgentLogo.replaceChildren();
  el.chatAgentLogo.classList.toggle("hidden", agentId == null);
  if (agentId != null) el.chatAgentLogo.appendChild(StepsembleAgentIdentity.create(document, agentId));
}

function setChatTitle(title) {
  const value = String(title || "").trim();
  el.chatTitle.textContent = value || (window.stepsembleI18n?.t("New conversation") || "New conversation");
  el.chatTitle.toggleAttribute("data-i18n-ignore", !!value);
  if (WORKSPACE_PANE && value) parent.postMessage({ type: "workspace-title", title: value }, location.origin);
}

async function openExisting(s) {
  beginDraftScope({ file: s.file, cwd: s.cwd, name: s.name });
  const generation = ++viewGeneration;
  if (rpc) closeChat(!!(rpc.streaming || rpc.connectionLost));
  resetTaskProgress();
  resetProjectChanges();
  resetComposerSummary();
  currentSessionFile = s.file;
  currentAgentTaskId = null;
  currentSessionCwd = s.cwd;
  clearLastAgentTask();
  rememberLastChat(s.file);
  updateSessionSelection();
  hideChatEmpty();
  setChatTitle(sessionDisplayTitle(s));
  setChatAgent(s.agentId ?? "pi");
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
    layoutWorkLog();
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
  if (el.changesCommit) {
    const stagedCount = (projectChangesState?.data?.files || []).filter((file) => file.staged).length;
    const commitLabel = changesText("commit");
    el.changesCommit.textContent = commitLabel;
    el.changesCommit.title = commitLabel;
    el.changesCommit.setAttribute("aria-label", commitLabel);
    // Committing nothing is never the intent, so the control stays inert until
    // at least one file is staged.
    el.changesCommit.disabled = changesMutationInFlight || stagedCount === 0;
    el.changesCommit.classList.toggle("hidden", !projectChangesState?.data?.repository);
  }
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

    // The file button fills the row, so the stage control is a sibling rather
    // than a nested button, which is invalid and breaks keyboard navigation.
    const row = document.createElement("div");
    row.className = "changes-file-entry" + (file.staged ? " staged" : "");
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "changes-file-stage";
    toggle.dataset.path = filePath;
    toggle.textContent = file.staged ? "−" : "+";
    const toggleLabel = changesText(file.staged ? "unstageFile" : "stageFile", { file: filePath });
    toggle.title = toggleLabel;
    toggle.setAttribute("aria-label", toggleLabel);
    toggle.setAttribute("aria-pressed", String(!!file.staged));
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      void setChangeStaged(filePath, !file.staged, toggle);
    });
    row.append(button, toggle);
    el.changesList.appendChild(row);
  }
}

// Staging and committing are the only writes this view performs. Both resolve
// against the project the view is currently showing, so a host or project
// switch mid-request cannot apply the result to the wrong repository.
async function setChangeStaged(filePath, staged, button) {
  const cwd = projectChangesState?.cwd || currentSessionCwd;
  if (!cwd || !filePath || changesMutationInFlight) return;
  changesMutationInFlight = true;
  if (button) button.disabled = true;
  try {
    const data = await post("/api/project-changes/stage", { cwd, paths: [filePath], staged });
    if (projectChangesState?.cwd !== cwd) return;
    projectChangesState = { status: "ready", cwd, data };
    renderProjectChanges();
  } catch (error) {
    toast(error.message || changesText("stageFailed"), true);
    if (button) button.disabled = false;
  } finally {
    changesMutationInFlight = false;
  }
}

async function commitProjectChanges() {
  const cwd = projectChangesState?.cwd || currentSessionCwd;
  const staged = (projectChangesState?.data?.files || []).filter((file) => file.staged);
  if (!cwd || changesMutationInFlight) return;
  if (!staged.length) { toast(changesText("commitNothing"), true); return; }
  const message = prompt(changesText("commitPrompt", { count: staged.length }));
  if (message === null) return;
  if (!String(message).trim()) { toast(changesText("commitEmpty"), true); return; }
  changesMutationInFlight = true;
  if (el.changesCommit) el.changesCommit.disabled = true;
  try {
    const data = await post("/api/project-changes/commit", { cwd, message });
    if (projectChangesState?.cwd !== cwd) return;
    projectChangesState = { status: "ready", cwd, data };
    renderProjectChanges();
    toast(changesText("commitDone", { commit: data?.commit || "" }));
  } catch (error) {
    toast(error.message || changesText("commitFailed"), true);
  } finally {
    changesMutationInFlight = false;
    renderProjectChangesChrome();
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
  const refresh = refreshProjectChanges({ background: true });
  requestAnimationFrame(() => el.changesClose?.focus());
  return refresh;
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
el.changesCommit?.addEventListener("click", () => void commitProjectChanges());
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
    layoutWorkLog({ keepScroll: true });
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

async function startNew(cwd, name, agentId = "pi", worktree = false, signal = null) {
  beginDraftScope({ cwd, name });
  const generation = ++viewGeneration;
  if (rpc) closeChat(!!(rpc.streaming || rpc.connectionLost));
  resetTaskProgress();
  resetProjectChanges();
  resetComposerSummary();
  currentSessionFile = null;
  currentAgentTaskId = null;
  _lastMsgDate = null;
  updateSessionSelection();
  lastUserText = "";
  currentSessionCwd = cwd;
  historyState = null;
  removeHistoryLoadButton();
  removeCodexNativeHistoryButton();
  autoScrollPinned = true;
  hideChatEmpty();
  setChatTitle(name);
  setChatAgent(agentId);
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
    await connectAgentTask({ agentId: String(agentId || "pi"), cwd, name, worktree: !!worktree, signal }, generation);
  }
}

function resetGenericReplayNotice() {
  if (!el.taskReplayNote) return;
  el.taskReplayNote.textContent = "";
  delete el.taskReplayNote.dataset.i18nKey;
  el.taskReplayNote.classList.add("hidden");
}

async function connectRpc(opts, generation = viewGeneration, openedResult = null, openedBase = apiBase, signal = null) {
  const baseAtStart = openedResult === null ? apiBase : openedBase;
  resetGenericReplayNotice();
  setStreaming(false);
  try {
    const r = openedResult === null ? await post("/api/open", opts, signal ? { signal } : {}) : openedResult;
    const sid = typeof r?.sid === "string" ? r.sid : "";
    if (!sid) throw new Error("Native session did not return a sid");
    if (signal?.aborted || generation !== viewGeneration || baseAtStart !== apiBase) {
      if (!r.reused) fetch(baseAtStart + "/api/close", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sid: r.sid }),
      }).catch(() => {});
      return;
    }
    if (openedResult !== null) {
      const openedCwd = typeof r.cwd === "string" ? r.cwd.trim() : "";
      const worktreeCwd = typeof r.worktree?.path === "string" ? r.worktree.path.trim() : "";
      if (!openedCwd || (worktreeCwd && worktreeCwd !== openedCwd)) {
        if (!r.reused) fetch(baseAtStart + "/api/close", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sid }),
        }).catch(() => {});
        throw new Error("Invalid native worktree response");
      }
      beginDraftScope({ cwd: openedCwd, name: el.chatTitle?.textContent || null });
      currentSessionCwd = openedCwd;
      el.chatSub.dataset.base = openedCwd;
      el.chatSub.textContent = openedCwd;
      resetProjectChanges();
      void refreshProjectChanges({ background: true });
    }
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
    if (signal?.aborted || generation !== viewGeneration || baseAtStart !== apiBase) return;
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

// Connectors whose prompt wire format carries image attachments. Terminal-only
// CLI connectors are excluded: their stdin takes text, so an attachment there
// would be silently dropped rather than seen by the agent.
function connectorAcceptsImages(connection = rpc) {
  if (!connection) return false;
  if (!connection.generic) return true; // Pi's native RPC has always taken images.
  if (connection.nativeHistoryReadonly === true || connection.readOnly === true) return false;
  // Codex model catalogs can explicitly restrict input modalities. A missing
  // field remains backwards-compatible (text + image), while an authoritative
  // text-only list disables attachments before a prompt is submitted.
  if (connection.nativeCodexMutation) {
    const modalities = connection.codexModel?.inputModalities;
    if (Array.isArray(modalities) && modalities.length
      && !modalities.some(value => /image/i.test(String(value)))) return false;
  }
  return !!(connection.nativeOpenCode || connection.nativeGrokAcp || connection.nativeAcp
    || connection.nativeClaudeStructured || connection.nativeCodexMutation);
}

// Model selection changes a conversation and requires mutation authority.
// Context is read-only observation and is intentionally gated separately.
function connectorAllowsLiveControls(connection = rpc) {
  if (!connection) return false;
  if (connection.nativeHistoryReadonly === true || connection.readOnly === true) return false;
  if (!connection.generic) return true;
  return !!(connection.nativeOpenCode || connection.nativeAcp || connection.nativeCodexMutation
    || connection.nativeClaudeStructured);
}

function genericTaskTerminal(status) {
  return ["completed", "failed", "stopped", "orphaned", "detached"].includes(String(status || ""));
}

function genericInputBlock(connection = rpc) {
  if (connection?.nativeHistoryReadonly === true || connection?.readOnly === true) return "taskReadOnly";
  if (connection?.nativeCodex && !connection.nativeCodexMutation) {
    return connection.taskStatus === "running" ? "taskObservedReadOnly" : "taskReadOnly";
  }
  if (connection?.nativeCodexMutation) {
    if (genericTaskTerminal(connection.taskStatus)) return "taskReadOnly";
    if (connection.nativeLoading || connection.connectionLost || connection.stopPending || !["running", "waiting"].includes(connection.taskStatus)) return "inputUnavailable";
    return null;
  }
  if (connection?.nativeClaudeStructured) {
    if (genericTaskTerminal(connection.taskStatus)) return "taskReadOnly";
    if (connection.nativeLoading || connection.connectionLost || connection.stopPending || !["running", "waiting"].includes(connection.taskStatus)) return "inputUnavailable";
    return null;
  }
  if (connection?.nativeAntigravityStructured) {
    if (genericTaskTerminal(connection.taskStatus)) return "taskReadOnly";
    if (connection.nativeLoading || connection.connectionLost || connection.stopPending || !["running", "waiting"].includes(connection.taskStatus)) return "inputUnavailable";
    return null;
  }
  if (connection?.nativeGrokAcp) {
    if (genericTaskTerminal(connection.taskStatus)) return "taskReadOnly";
    if (connection.nativeLoading || connection.connectionLost || connection.stopPending || !["running", "waiting"].includes(connection.taskStatus)) return "inputUnavailable";
    return null;
  }
  if (connection?.nativeAcp) {
    if (genericTaskTerminal(connection.taskStatus)) return "taskReadOnly";
    if (connection.nativeLoading || connection.connectionLost || connection.stopPending || !["running", "waiting"].includes(connection.taskStatus)) return "inputUnavailable";
    return null;
  }
  if (connection?.nativeOpenCode) {
    if (genericTaskTerminal(connection.taskStatus)) return "taskReadOnly";
    if (connection.stopPending || connection.nativeLoading || !["running", "waiting"].includes(connection.taskStatus)) return "inputUnavailable";
    return null;
  }
  if (!connection?.generic) return null;
  if (genericTaskTerminal(connection.taskStatus)) return "taskReadOnly";
  if (connection.streamReady !== true || connection.connectionLost || connection.stopPending
    || !["running", "waiting"].includes(connection.taskStatus)) return "inputUnavailable";
  return null;
}

function applyGenericReplayMetadata(snapshot = {}) {
  if (!rpc?.generic) return;
  if (snapshot.replayGap === true) rpc.genericReplayGap = true;
  if (snapshot.canonical?.historyTruncated === true) rpc.genericReplayGap = true;
  if (rpc.genericReplayGap && el.taskReplayNote) {
    el.taskReplayNote.dataset.i18nKey = "runtime.genericReplayGap";
    el.taskReplayNote.textContent = tKey("runtime.genericReplayGap");
    el.taskReplayNote.classList.remove("hidden");
  }
}

function genericApprovalRows(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows.filter(row => row?.approval && ["pending", "approved", "denied"].includes(row.approval.status) && row.nativeAcknowledgement === null);
}

function genericApprovalCard(approvalId) {
  const id = String(approvalId || "");
  return [...(el.messages?.querySelectorAll("[data-generic-approval]") || [])]
    .find(node => node.dataset.genericApproval === id) || null;
}

function renderGenericApproval(row) {
  if (!rpc?.generic || !row?.approval?.approvalId) return;
  const approval = row.approval;
  const id = String(approval.approvalId);
  const existing = genericApprovalCard(id);
  if (existing) {
    const state = existing.querySelector("[data-role=approval-state]");
    if (state) state.textContent = approval.status === "pending" ? "Waiting for your decision" : `Decision: ${approval.status} · waiting for agent confirmation`;
    existing.querySelectorAll("button").forEach(button => { button.disabled = approval.status !== "pending"; });
    return;
  }
  const shell = makeMsgShell("assistant", rpc.agentLabel || "Agent");
  const card = document.createElement("div");
  card.className = "agent-approval-card";
  card.dataset.genericApproval = id;
  const title = document.createElement("strong");
  title.textContent = "Approval required";
  const summary = document.createElement("p");
  summary.textContent = String(approval.request?.summary || "The agent is requesting permission.");
  const state = document.createElement("small");
  state.dataset.role = "approval-state";
  state.textContent = approval.status === "pending" ? "Waiting for your decision" : `Decision: ${approval.status} · waiting for agent confirmation`;
  const actions = document.createElement("div");
  actions.className = "agent-approval-actions";
  for (const [decision, label] of [["approved", "Allow"], ["denied", "Deny"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = decision === "approved" ? "btn primary" : "btn ghost";
    button.textContent = label;
    button.addEventListener("click", async () => {
      button.disabled = true;
      actions.querySelectorAll("button").forEach(item => { item.disabled = true; });
      try {
        const result = await post("/api/agent/approval", { taskId: currentAgentTaskId, approvalId: id, nonce: approval.nonce, scope: approval.scope, decision });
        state.textContent = result?.kind === "dispatched" ? `Decision: ${decision} · waiting for agent confirmation` : "Decision recorded; waiting for agent confirmation";
      } catch (error) {
        state.textContent = error?.message || "Could not record the decision";
        actions.querySelectorAll("button").forEach(item => { item.disabled = false; });
      }
    });
    actions.appendChild(button);
  }
  card.append(title, summary, state, actions);
  shell.bubble.appendChild(card);
  scrollBottom();
}

function applyGenericApprovals(rows) {
  const all = Array.isArray(rows) ? rows : [];
  for (const row of genericApprovalRows(all)) renderGenericApproval(row);
  // A native ACK removes the row from `pendingApprovals`. Keep the card in
  // the transcript, but make the durable boundary visible instead of leaving
  // the user with a permanently disabled “waiting” prompt.
  for (const row of all) {
    const approval = row?.approval;
    if (!approval?.approvalId || !row.nativeAcknowledgement) continue;
    const card = genericApprovalCard(approval.approvalId);
    if (!card) continue;
    const state = card.querySelector("[data-role=approval-state]");
    if (state) state.textContent = `Agent confirmed · ${approval.status}`;
    card.querySelectorAll("button").forEach(button => { button.disabled = true; });
    card.dataset.approvalAcknowledged = "true";
  }
}

async function loadGenericCanonicalHistory(snapshot, taskId, connection) {
  const canonical = snapshot?.canonical;
  if (!canonical?.durable || !canonical.sessionId || !canonical.cursor?.generation) return false;
  const owns = () => rpc === connection && connection.sid === taskId && !connection.streamEnded;
  const floor = Number.isSafeInteger(canonical.historyFloor) ? canonical.historyFloor : 0;
  let cursor = { sessionId: String(canonical.sessionId), generation: String(canonical.cursor.generation), sequence: floor };
  let pages = 0;
  let renderedBytes = 0;
  const maxRenderedBytes = 512 * 1024;
  try {
    while (owns() && pages++ < 100) {
      const query = new URLSearchParams({ taskId, sessionId: cursor.sessionId, generation: cursor.generation, sequence: String(cursor.sequence), limit: "100" });
      const page = await api(`/api/agent-events?${query.toString()}`);
      if (!owns() || page?.kind !== "events" || !page.cursor || !Array.isArray(page.events)) return false;
      for (const event of page.events) {
        if (!owns()) return false;
        if (event.type === "message.delta" && event.payload?.channel === "text") {
          const delta = String(event.payload.delta || "");
          const bytes = new TextEncoder().encode(delta).byteLength;
          if (bytes && renderedBytes < maxRenderedBytes) {
            const remaining = maxRenderedBytes - renderedBytes;
            const value = bytes <= remaining ? delta : delta.slice(0, Math.max(0, Math.floor(delta.length * remaining / bytes)));
            appendGenericOutput(value, "stdout");
            renderedBytes += new TextEncoder().encode(value).byteLength;
            if (value.length < delta.length) rpc.genericReplayGap = true;
          }
        } else if (event.type === "message.completed" && event.payload?.role === "user") {
          appendGenericInput(String(event.payload.content || ""));
        }
      }
      cursor = { sessionId: String(page.cursor.sessionId), generation: String(page.cursor.generation), sequence: Number(page.cursor.sequence) };
      if (page.hasMore !== true) break;
    }
    applyGenericApprovals(canonical.pendingApprovals);
    applyGenericReplayMetadata(snapshot);
    return true;
  } catch {
    // The bounded SSE replay remains the fallback when an older Host has no
    // canonical event route or the journal is temporarily unavailable.
    return false;
  }
}

function syncGenericInputState() {
  syncApprovalControl();
  const reason = genericInputBlock();
  el.input.readOnly = !!reason;
  el.btnSend.disabled = !!reason;
  const note = $("agent-input-note");
  if (note) {
    note.classList.toggle("hidden", !reason);
    if (reason) { note.dataset.i18nKey = `agentHub.${reason}`; note.textContent = agentHubText(reason); }
    else { delete note.dataset.i18nKey; note.textContent = ""; }
  }
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

function ensureGenericOutputNode(stream = "stdout") {
  if (!rpc?.generic) return null;
  if (!rpc.genericOutputNode || rpc.genericOutputNode.dataset.stream !== stream) {
    const shell = makeMsgShell("assistant", rpc.agentLabel || "Agent");
    const structured = stream === "stdout" && !!(rpc.nativeClaudeStructured || rpc.nativeGrokAcp || rpc.nativeAcp || rpc.nativeAntigravityStructured);
    const output = document.createElement(structured ? "div" : "pre");
    output.className = structured ? "agent-structured-output" : `agent-terminal-output ${stream === "stderr" ? "stderr" : "stdout"}`;
    output.dataset.stream = stream;
    output.__rawText = "";
    shell.bubble.appendChild(output);
    rpc.genericOutputNode = output;
  }
  return rpc.genericOutputNode;
}

function genericOutputText(node) {
  return typeof node?.__rawText === "string" ? node.__rawText : String(node?.textContent || "");
}

function setGenericOutputText(node, value) {
  if (!node) return;
  const next = String(value || "");
  node.__rawText = next;
  if (!node.classList.contains("agent-structured-output")) {
    node.textContent = next;
    return;
  }
  if (node.__renderFrame) return;
  node.__renderFrame = requestAnimationFrame(() => {
    node.__renderFrame = null;
    if (!node.isConnected) return;
    node.replaceChildren(renderMarkdown(node.__rawText || ""));
    scrollBottom();
  });
}

function appendGenericOutput(text, stream = "stdout") {
  if (!rpc?.generic) return;
  const clean = stripAnsi(String(text ?? ""));
  if (!clean) return;
  const node = ensureGenericOutputNode(stream);
  if (!node) return;
  setGenericOutputText(node, genericOutputText(node) + clean);
  scrollBottom();
}

function replaceClaudeStructuredOutputTail(connection, text) {
  if (rpc !== connection || !connection?.nativeClaudeStructured) return;
  const clean = stripAnsi(String(text ?? ""));
  if (!clean) return;
  const node = ensureGenericOutputNode("stdout");
  if (!node) return;
  const current = genericOutputText(node);
  const start = Number.isSafeInteger(connection.claudeOutputStart)
    ? Math.min(Math.max(0, connection.claudeOutputStart), current.length) : current.length;
  setGenericOutputText(node, current.slice(0, start) + clean);
  scrollBottom();
}

function appendGenericInput(text, truncated = false) {
  if (!rpc?.generic) return;
  const clean = stripAnsi(String(text ?? ""));
  if (!clean) return;
  const shell = makeMsgShell("user", "你");
  const pre = document.createElement("pre");
  pre.className = "agent-terminal-input";
  pre.textContent = clean + (truncated ? "\n…" : "");
  shell.bubble.appendChild(pre);
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
  if (snapshot.agentId) setChatAgent(snapshot.agentId);
  applyGenericReplayMetadata(snapshot);
  if (normalizedTimestampMs(snapshot.startedAt)) rpc.runStartedAt = normalizedTimestampMs(snapshot.startedAt);
  if (normalizedTimestampMs(snapshot.endedAt)) rpc.runEndedAt = normalizedTimestampMs(snapshot.endedAt);
  rpc.activityLabel = status === "waiting" ? "waiting" : "working";
  updateAgentTaskCache({ ...snapshot, id: snapshot.id || snapshot.taskId || rpc.sid, agentId: rpc.agentId, name: rpc.name, cwd: rpc.cwd });
  // Codex native history is deliberately read-only. Even an active native
  // thread must not expose the generic abort/send controls through this
  // metadata-only adapter.
  setStreaming(rpc.nativeCodex && !rpc.nativeCodexMutation ? false : agentTaskIsRunning({ status }));
  if (genericTaskTerminal(status)) appendGenericTerminalNotice(status, snapshot);
}

function handleAgentTaskEvent(ev, eventSid = rpc?.sid) {
  if (!rpc?.generic || (eventSid && rpc.sid !== eventSid)) return;
  markRpcActivity();
  if (!ev || typeof ev !== "object") return;
  if (ev.type === "connected") {
    applyGenericTaskSnapshot(ev);
    applyGenericApprovals(ev.canonical?.pendingApprovals);
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
  if (ev.type === "input") {
    const text = typeof ev.text === "string" ? ev.text : "";
    if (!text) return;
    const echoes = Array.isArray(rpc.genericInputEchoes) ? rpc.genericInputEchoes : [];
    const now = Date.now();
    while (echoes.length && now - echoes[0].at > 60_000) echoes.shift();
    const echoIndex = echoes.findIndex(item => item.text === text);
    if (echoIndex >= 0) echoes.splice(echoIndex, 1);
    else appendGenericInput(text, ev.truncated === true);
    return;
  }
  if (ev.type === "protocol_event") {
    if (ev.event?.type === "approval.requested") applyGenericApprovals([ev.approval]);
    return;
  }
  if (ev.type === "approval.updated") {
    applyGenericApprovals(ev.canonical?.approvals || ev.canonical?.pendingApprovals);
    return;
  }
  if (ev.type === "task_exit") {
    applyGenericTaskSnapshot({ ...ev, status: ev.status || rpc.taskStatus });
    if (genericTaskTerminal(ev.status || rpc.taskStatus)) rpc.streamEnded = true;
    setStreaming(false);
  }
}

function openCodeMessageText(message) {
  return agentTranscriptPresentation.openCodeMessage(message)?.text || "";
}

function appendNormalizedAgentMessage(view, label, container = el.messages, model = null) {
  if (!view) return null;
  if (view.role === "user") {
    const { bubble } = makeMsgShell("user", "你", container);
    if (view.text) bubble.appendChild(renderMarkdown(view.text));
    if (!view.text && view.images) {
      const note = document.createElement("span");
      note.className = "image-message-fallback";
      note.textContent = `[${view.images} 張附件]`;
      bubble.appendChild(note);
    }
    return bubble;
  }
  const { wrap, bubble } = makeMsgShell("assistant", model ? `${label} · ${model}` : label, container);
  const tools = Array.isArray(view.tools) ? view.tools : [];
  // Render parts in the order the agent produced them; older presentations
  // without a sequence show reasoning, prose and then tools.
  const sequence = Array.isArray(view.sequence) && view.sequence.length ? view.sequence : [
    ...(view.thinking ? [{ kind: "thinking", text: view.thinking }] : []),
    ...(view.text ? [{ kind: "text", text: view.text }] : []),
    ...tools.map(tool => ({ kind: "tool", tool })),
  ];
  let activity = null;
  const finishActivity = () => {
    if (!activity) return;
    const cards = activityCards(activity);
    updateActivityGroup(activity, {
      running: cards.some(card => card.classList.contains("running")), count: cards.length,
      latest: activity.latest || "Thinking", hasError: cards.some(card => card.classList.contains("err")),
    });
    activity = null;
  };
  const workGroup = () => {
    if (!activity) {
      activity = makeActivityGroup({ running: false });
      bubble.appendChild(activity.details);
    }
    return activity;
  };
  for (const part of sequence) {
    if (part.kind === "text") {
      finishActivity();
      if (part.text) bubble.appendChild(renderMarkdown(part.text));
    } else if (part.kind === "thinking") {
      if (part.text) workGroup().body.appendChild(makeThinking(part.text));
    } else if (part.kind === "tool" && part.tool) {
      const tool = part.tool;
      const output = tool.output || (tool.running ? null : tool.isError ? "（沒有收到工具輸出）" : "（無輸出）");
      const card = makeToolCard(tool.name, tool.args, output, tool.isError, tool.running);
      card.dataset.nativeToolId = tool.id || "";
      workGroup().body.appendChild(card);
      activity.latest = toolTitle(tool.name, tool.args, tool.running);
    }
  }
  finishActivity();
  if (view.text) wrap.appendChild(msgActionsRow("assistant", () => view.text));
  return bubble;
}

function nativeOpenCodePermissionCard(permission) {
  if (!rpc?.nativeOpenCode || !permission?.id) return;
  // Keep the approval bound to the session that rendered it. The user can
  // switch tasks while a permission card is visible; reading global `rpc` at
  // click time could otherwise answer the next session's request.
  const connection = rpc;
  const existing = [...(el.messages?.querySelectorAll("[data-opencode-permission]") || [])]
    .find(node => node.dataset.opencodePermission === String(permission.id));
  if (existing) return;
  const shell = makeMsgShell("assistant", rpc.agentLabel || "OpenCode");
  const card = document.createElement("div");
  card.className = "agent-approval-card";
  card.dataset.opencodePermission = String(permission.id);
  const title = document.createElement("strong");
  title.textContent = "OpenCode permission required";
  const summary = document.createElement("p");
  const target = Array.isArray(permission.pattern) ? permission.pattern.join(", ") : permission.pattern || "*";
  summary.textContent = `${permission.permission || "tool"} · ${permission.title || target}`;
  const state = document.createElement("small");
  state.dataset.role = "approval-state";
  state.textContent = "Waiting for your decision";
  const actions = document.createElement("div");
  actions.className = "agent-approval-actions";
  for (const [decision, label] of [["once", "Allow once"], ["always", "Allow always"], ["reject", "Reject"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = decision === "reject" ? "btn ghost" : "btn primary";
    button.textContent = label;
    button.addEventListener("click", async () => {
      button.disabled = true;
      actions.querySelectorAll("button").forEach(item => { item.disabled = true; });
      try {
        await post("/api/opencode/permission", { sessionId: connection.nativeSessionId, cwd: connection.cwd, permissionId: permission.id, response: decision, remember: decision === "always" });
        state.textContent = `Decision: ${decision} · OpenCode is reconciling`;
      } catch (error) {
        state.textContent = error?.message || "Could not record the decision";
        actions.querySelectorAll("button").forEach(item => { item.disabled = false; });
      }
    });
    actions.appendChild(button);
  }
  card.append(title, summary, state, actions);
  shell.bubble.appendChild(card);
}

function renderOpenCodeNativeSnapshot(snapshot, { replace = false } = {}) {
  if (!rpc?.nativeOpenCode || !snapshot) return;
  if (replace) {
    el.messages.innerHTML = "";
    rpc.nativeRenderedRevision = null;
  }
  const revision = String(snapshot.revision || "");
  if (!replace && revision && revision === rpc.nativeRenderedRevision) return;
  if (!replace) el.messages.innerHTML = "";
  const messages = Array.isArray(snapshot.messages) ? [...snapshot.messages] : [];
  messages.sort((a, b) => (Number(a?.time?.created) || 0) - (Number(b?.time?.created) || 0));
  for (const message of messages) {
    const view = agentTranscriptPresentation.openCodeMessage(message);
    if (!view) continue;
    const bubble = appendNormalizedAgentMessage(view, "OpenCode", el.messages,
      message?.info?.model?.modelID || message?.info?.model?.modelId || message?.info?.modelID || null);
    stampMessageTime(bubble?.parentNode, message?.time?.completed || message?.info?.time?.completed
      || message?.time?.created || message?.info?.time?.created);
  }
  for (const permission of Array.isArray(snapshot.permissions) ? snapshot.permissions : []) nativeOpenCodePermissionCard(permission);
  if (revision) rpc.nativeRenderedRevision = revision;
  keepSessionUsageAtEnd();
  scrollBottom();
}

function nativeOpenCodeStatus(snapshot) {
  const type = String(snapshot?.status?.type || snapshot?.status?.status || "idle").toLowerCase();
  return ["active", "busy", "running"].includes(type) ? "running" : ["error", "failed"].includes(type) ? "failed" : "waiting";
}

async function refreshOpenCodeNativeSnapshot(connection, { initial = false } = {}) {
  if (!connection || rpc !== connection || !connection.nativeOpenCode) return;
  if (connection.nativeRefreshInFlight) return;
  connection.nativeRefreshInFlight = true;
  try {
    // Imported OpenCode history may point at a directory that is no longer
    // one of Stepsemble's allowed project folders (for example `/`, a
    // temporary checkout, or a folder moved since the task was created).
    // The upstream session id is sufficient for read-only reconciliation;
    // omitting cwd lets the configured OpenCode server resolve that session
    // without weakening the directory guard on mutating routes.
    const directory = connection.nativeOpenCodeReadOnly ? "" : connection.cwd;
    const snapshot = await post("/api/opencode/reconcile", { sessionId: connection.nativeSessionId, cwd: directory, limit: 200 });
    if (rpc !== connection) return;
    connection.openCodeContextSnapshot = snapshot;
    const latest = openCodeContext.selectLatestAssistantMessage(snapshot?.messages || []);
    const observedModel = normalizeOpenCodeModel(snapshot?.session?.model)
      || normalizeOpenCodeModel(latest?.info?.model || latest?.info || latest);
    if (observedModel && (!connection.openCodeModelSelected
      || openCodeContext.modelIdentity(observedModel) === openCodeContext.modelIdentity(connection.openCodeModel))) {
      applyOpenCodeModel(observedModel);
    }
    // A native idle OpenCode session is stored history, even though the
    // server's status endpoint reports `idle`/`waiting`. Preserve that
    // distinction in the task catalog so re-opening the same row never turns
    // it into a live mutation task with a stale cwd.
    const status = connection.nativeOpenCodeReadOnly ? "history" : nativeOpenCodeStatus(snapshot);
    applyOpenCodeContextStats(snapshot, connection);
    void syncOpenCodeModelCatalog(connection);
    applyGenericTaskSnapshot({ id: connection.sid, taskId: connection.sid, agentId: "opencode", nativeOpenCode: true,
      nativeSessionId: connection.nativeSessionId, name: connection.name, cwd: connection.cwd, status,
      nativeHistoryReadonly: connection.nativeOpenCodeReadOnly, readOnly: connection.nativeOpenCodeReadOnly,
      idleNativeSession: connection.nativeOpenCodeReadOnly, history: connection.nativeOpenCodeReadOnly ? "native_readonly" : "native_api",
      startedAt: connection.runStartedAt, lastActivityAt: Date.now() });
    renderOpenCodeNativeSnapshot(snapshot, { replace: initial || snapshot.changed === true || !connection.nativeRenderedRevision });
    connection.nativeLoading = false;
    connection.connectionLost = false;
    syncGenericInputState();
  } catch (error) {
    if (rpc !== connection) return;
    connection.nativeLoading = false;
    connection.connectionLost = true;
    contextStatsState = "unavailable";
    renderContextDashboard();
    syncGenericInputState();
    if (initial) throw error;
  } finally {
    connection.nativeRefreshInFlight = false;
  }
}

function codexNativeItemText(item) {
  const view = agentTranscriptPresentation.codexItem(item);
  return view?.text || view?.tool?.output || "";
}

function appendCodexNativeItem(item, container = el.messages) {
  const view = agentTranscriptPresentation.codexItem(item);
  if (!view) return;
  if (view.kind === "message" && view.role === "user") {
    const { bubble } = makeMsgShell("user", "你", container);
    if (view.text) bubble.appendChild(renderMarkdown(view.text));
    return;
  }
  if (view.kind === "message") {
    const { wrap, bubble } = makeMsgShell("assistant", "Codex", container);
    if (view.text) bubble.appendChild(renderMarkdown(view.text));
    if (view.text) wrap.appendChild(msgActionsRow("assistant", () => view.text));
    return;
  }
  const { bubble } = makeMsgShell("assistant", "Codex", container);
  if (view.kind === "thinking") {
    bubble.appendChild(makeThinking(view.text));
    return;
  }
  if (view.kind === "tool") {
    const tool = view.tool;
    const output = tool.output || (tool.running ? null : tool.isError ? "（沒有收到工具輸出）" : "（無輸出）");
    const card = makeToolCard(tool.name, tool.args, output, tool.isError, tool.running);
    card.classList.add("native-tool-card");
    card.dataset.nativeToolId = tool.id || "";
    bubble.appendChild(card);
  }
}

function codexNativeRenderUnits(entries) {
  const units = [];
  // Consecutive tool and reasoning items form one unit; an assistant message
  // closes it, so commentary and work keep their order within a turn.
  const openWork = new Map();
  for (const entry of [...entries].reverse()) {
    const view = agentTranscriptPresentation.codexItem(entry.item);
    if (!view) continue;
    const turnId = String(entry.turnId || "unknown-turn");
    if (view.kind === "tool" || view.kind === "thinking") {
      let unit = openWork.get(turnId);
      if (!unit) {
        unit = { key: `work:${turnId}:${entry.item.id}`, kind: "work", turnId, rows: [] };
        openWork.set(turnId, unit);
        units.push(unit);
      }
      unit.rows.push({ item: entry.item, view });
      continue;
    }
    openWork.delete(turnId);
    units.push({ key: `item:${codexNativeEntryKey(entry)}`, kind: "message", item: entry.item, view, turnId });
  }
  return units;
}

function appendCodexNativeActivity(rows, container = el.messages, key = "") {
  const values = Array.isArray(rows) ? rows : [];
  if (!values.length) return;
  const { bubble } = makeMsgShell("assistant", "Codex", container);
  const tools = values.map(row => row.view?.tool).filter(tool => tool && tool.name !== "view_image");
  const activity = makeActivityGroup({ running: tools.some(tool => tool.running), count: tools.length });
  if (key) activity.details.dataset.workKey = key;
  bubble.appendChild(activity.details);
  // Reasoning, image views and tools stay in the order Codex produced them.
  let images = [];
  const flushImages = () => {
    if (images.length) activity.body.appendChild(makeCodexImageViews(images));
    images = [];
  };
  for (const row of values) {
    if (row.view?.kind === "thinking") {
      flushImages();
      activity.body.appendChild(makeThinking(row.view.text));
      continue;
    }
    const tool = row.view?.tool;
    if (!tool) continue;
    if (tool.name === "view_image") { images.push(tool); continue; }
    flushImages();
    const output = tool.output || (tool.running ? null : tool.isError ? "（沒有收到工具輸出）" : "（無輸出）");
    const card = makeToolCard(tool.name, tool.args, output, tool.isError, tool.running);
    card.classList.add("native-tool-card");
    card.dataset.nativeToolId = tool.id || "";
    activity.body.appendChild(card);
    activity.latest = toolTitle(tool.name, tool.args, tool.running);
  }
  flushImages();
  updateActivityGroup(activity, {
    running: tools.some(tool => tool.running), count: tools.length,
    latest: activity.latest || "Thinking", hasError: tools.some(tool => tool.isError),
  });
}

// Cursors are independent: undefined retries the first page, null means EOF.
function createCodexNativeTranscriptState() {
  return { turnsCursor: undefined, itemsCursor: undefined, turns: [], entries: [],
    seenTurns: new Set(), seenItems: new Set(), hasMore: true, loading: false,
    initialized: false, error: null, olderError: null, thread: null,
    itemsBoundary: null, itemGapKeys: null, goal: null, goalAvailable: null,
    observation: null };
}

function codexGoalTitle(status) {
  if (status === "paused") return window.stepsembleI18n?.t("Goal paused") || "Goal paused";
  if (status === "blocked") return window.stepsembleI18n?.t("Goal blocked") || "Goal blocked";
  if (status === "usageLimited" || status === "budgetLimited") return window.stepsembleI18n?.t("Goal limit reached") || "Goal limit reached";
  return window.stepsembleI18n?.t("Pursuing goal") || "Pursuing goal";
}

function renderCodexNativeRunState(connection) {
  const root = el.nativeRunState;
  if (!root) return;
  const state = connection?.nativeCodex ? connection.nativeTranscriptState : null;
  const running = connection?.taskStatus === "running" || state?.thread?.status?.type === "active"
    || state?.observation?.working === true;
  const goal = state?.goal && state.goal.status !== "complete" ? state.goal : null;
  // Plain work is shown in the conversation's own "Working for …" header;
  // this banner remains only for a Codex goal, which spans several turns.
  if (!connection || !goal) {
    root.classList.add("hidden");
    root.classList.remove("running", "has-goal");
    return;
  }
  const elapsed = running && connection.runStartedAt
    ? runElapsedText(Date.now() - connection.runStartedAt)
    : goal ? runElapsedText(Math.max(0, Number(goal.timeUsedSeconds) || 0) * 1000) : "";
  root.classList.remove("hidden");
  root.classList.toggle("running", running);
  root.classList.toggle("has-goal", !!goal);
  const title = goal ? codexGoalTitle(goal.status)
    : (window.stepsembleI18n?.t("Working…") || "Working…");
  root.setAttribute("aria-label", title);
  el.nativeRunTitle.textContent = title;
  el.nativeRunDetail.textContent = goal.objective;
  el.nativeRunMeta.textContent = [running ? (window.stepsembleI18n?.t("Working…") || "Working…") : "", elapsed]
    .filter(Boolean).join(" · ");
}

function codexNativeEntryKey(entry) {
  return JSON.stringify([entry.turnId, entry.item.id]);
}

// Both inputs are in native descending creation order. Prefer the fresher
// record on overlap, and never join items from different turns by item ID alone.
function mergeCodexNativeRows(existing, incoming, key, older, boundary = null) {
  const values = new Map();
  const boundaryIndex = older && boundary !== null ? existing.findIndex(row => key(row) === boundary) : -1;
  const ordered = boundaryIndex >= 0
    ? [...existing.slice(0, boundaryIndex + 1), ...incoming, ...existing.slice(boundaryIndex + 1)]
    : older ? [...existing, ...incoming] : [...incoming, ...existing];
  const fresher = older ? new Map(existing.map(row => [key(row), row])) : null;
  for (const row of ordered) {
    const id = key(row);
    if (!values.has(id)) values.set(id, fresher?.get(id) || row);
  }
  return [...values.values()];
}

function applyCodexNativeTranscriptPage(state, page, { older = false } = {}) {
  const errors = [];
  for (const [kind, rows, seen, rowKey] of [
    ["turns", "turns", "seenTurns", turn => turn.id],
    ["items", "entries", "seenItems", codexNativeEntryKey],
  ]) {
    const result = page[kind];
    if (!result) continue; // An exhausted stream is not requested again.
    if (result.error) { errors.push(result.error); continue; }
    const next = result.nextCursor;
    if (older && next !== null && (next === state[kind + "Cursor"] || state[seen].has(next))) {
      errors.push("codex_history_cursor_repeated");
      continue;
    }
    // A busy/backgrounded thread may advance by more than one latest page.
    // Reopen the item boundary at that page so the missing middle stays
    // reachable; insert subsequent pages there, before retained older rows.
    const existingKeys = kind === "items" ? new Set(state.entries.map(rowKey)) : null;
    const gap = !older && kind === "items" && state.entries.length && result.data.length
      && next !== null && !result.data.some(row => existingKeys.has(rowKey(row)));
    if (gap) {
      state.itemGapKeys ||= existingKeys;
      state.seenItems.clear();
    }
    if (older && kind === "items" && (next === null || result.data.some(row => state.itemGapKeys?.has(rowKey(row))))) {
      state.itemGapKeys = null;
    }
    state[rows] = mergeCodexNativeRows(state[rows], result.data, rowKey, older, kind === "items" ? state.itemsBoundary : null);
    // Latest polling must not reset the user's older-history boundary.
    if (older || gap || !state.initialized || state[kind + "Cursor"] === undefined) {
      state[kind + "Cursor"] = next;
      if (kind === "items" && result.data.length) state.itemsBoundary = rowKey(result.data.at(-1));
      if (next !== null) state[seen].add(next);
    }
  }
  if (page.thread) state.thread = page.thread;
  state.initialized = true;
  state.error = errors.join(", ") || null;
  state.hasMore = state.turnsCursor !== null || state.itemsCursor !== null;
}

function removeCodexNativeHistoryButton() {
  if (codexNativeHistoryButton) codexNativeHistoryButton.remove();
  codexNativeHistoryButton = null;
}

function showCodexNativeHistoryButton() {
  const state = rpc?.nativeCodex ? rpc.nativeTranscriptState : null;
  if (!state?.hasMore) { removeCodexNativeHistoryButton(); return; }
  if (!codexNativeHistoryButton) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-load-button";
    button.addEventListener("click", () => void loadOlderCodexNativeHistory());
    codexNativeHistoryButton = button;
  }
  const busy = state.loading || !!rpc.nativeRefreshInFlight;
  const labelKey = busy ? "runtime.historyLoading" : state.error ? "runtime.historyRetry" : "runtime.historyOlder";
  codexNativeHistoryButton.dataset.i18nKey = labelKey;
  codexNativeHistoryButton.textContent = tKey(labelKey);
  codexNativeHistoryButton.disabled = busy;
  codexNativeHistoryButton.setAttribute("aria-busy", String(busy));
  if (codexNativeHistoryButton.parentNode !== el.messages) el.messages.prepend(codexNativeHistoryButton);
}

async function loadCodexNativeTranscript(threadId, {
  older = false, turnsCursor, itemsCursor, signal, isCurrent = () => true,
} = {}) {
  const base = apiBase;
  const current = () => {
    if (signal?.aborted || base !== apiBase || !isCurrent()) {
      throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    }
  };
  const read = async (path, params) => {
    current();
    const result = await api(path + "?" + new URLSearchParams(params), { signal });
    current();
    return result;
  };
  const page = { thread: null, turns: null, items: null };
  if (!older) {
    const metadata = await read("/api/codex/thread", { threadId, includeTurns: "0" });
    page.thread = metadata.thread;
    page.goal = metadata.goal || null;
    page.goalAvailable = metadata.goalAvailable === true;
    page.observation = metadata.observation || null;
  }
  for (const [kind, cursor, limit] of [["turns", turnsCursor, 20], ["items", itemsCursor, 50]]) {
    if (older && cursor === null) continue;
    try {
      const params = { threadId, limit: String(limit), sortDirection: "desc" };
      // Turn summaries are metadata; only items/list defines transcript order.
      if (kind === "turns") params.itemsView = "summary";
      if (cursor !== null && cursor !== undefined) params.cursor = cursor;
      const result = await read("/api/codex/" + kind, params);
      const validRow = row => kind === "turns"
        ? typeof row?.id === "string" && Array.isArray(row.items)
        : typeof row?.turnId === "string" && typeof row?.item?.id === "string" && typeof row.item.type === "string";
      if (!Array.isArray(result?.data) || result.data.length > limit || !result.data.every(validRow)
        || result.nextCursor !== null && (typeof result.nextCursor !== "string" || !result.nextCursor.length || result.nextCursor.length > 512)) {
        throw new Error("codex_history_page_invalid");
      }
      page[kind] = { data: result.data, nextCursor: result.nextCursor };
    } catch (error) {
      current();
      page[kind] = { error: String(error?.code || error?.message || "codex_history_unavailable").slice(0, 128) };
    }
  }
  return page;
}

// The Codex app-server can still be completing its compatibility handshake
// immediately after Stepsemble starts.  Keep that short-lived state separate
// from a real missing-thread/auth error so the first tap does not open a chat
// with no transcript and no composer controls.
function isCodexNativeTransientError(error) {
  const code = String(error?.code || error?.message || "").toLowerCase();
  return code === "native_not_ready"
    || code === "codex_native_not_ready"
    || code === "codex_thread_unavailable"
    || code === "codex_models_unavailable"
    || code === "native_transport_starting"
    || code.includes("native_not_ready");
}

async function retryCodexNativeTransient(operation, { attempts = 5, delays = [120, 350, 700, 1200] } = {}) {
  let lastError = null;
  const count = Math.max(1, Number(attempts) || 1);
  for (let attempt = 0; attempt < count; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (error?.name === "AbortError" || !isCodexNativeTransientError(error) || attempt >= count - 1) throw error;
      const delay = Math.max(0, Number(delays[attempt]) || 0);
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastError || new Error("native_not_ready");
}

// The composer shows a sent message at once. Codex then returns the same
// message as its own item, which takes the echo's place: matched by turn id
// once the send reply names the turn, and by text before that.
function codexNativeEchoText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function trackCodexNativeEcho(connection, node, message) {
  const echo = { node, text: codexNativeEchoText(message), turnId: null,
    knownKeys: new Set(connection.nativeRenderedItems?.keys() || []) };
  (connection.codexNativeEchoes ||= []).push(echo);
  return echo;
}

function dropCodexNativeEcho(connection, echo) {
  echo.node?.remove?.();
  if (Array.isArray(connection?.codexNativeEchoes)) {
    connection.codexNativeEchoes = connection.codexNativeEchoes.filter(row => row !== echo);
  }
}

function reconcileCodexNativeEchoes(connection) {
  const echoes = connection?.codexNativeEchoes;
  if (!Array.isArray(echoes) || !echoes.length) return;
  const users = [];
  for (const [key, row] of connection.nativeRenderedItems || []) if (row.user) users.push({ key, ...row.user });
  const claimed = new Set();
  connection.codexNativeEchoes = echoes.filter(echo => {
    if (!echo.node?.isConnected) return false;
    const match = users.find(user => !claimed.has(user.key) && !echo.knownKeys.has(user.key)
      && (echo.turnId ? user.turnId === echo.turnId : !!echo.text && user.text === echo.text));
    if (!match) return true;
    claimed.add(match.key);
    echo.node.remove();
    return false;
  });
}

function renderCodexNativeSnapshot(connection, { preserveScroll = false } = {}) {
  if (rpc !== connection || !connection?.nativeCodex) return;
  const state = connection.nativeTranscriptState;
  const rendered = connection.nativeRenderedItems ||= new Map();
  const oldTop = el.messages.scrollTop;
  const oldHeight = el.messages.scrollHeight;
  const preserve = preserveScroll || !autoScrollPinned;
  const viewport = el.messages.getBoundingClientRect();
  const viewportTop = viewport.top;
  let anchor = null, anchorOffset = 0;
  if (preserve) {
    for (const { node } of rendered.values()) {
      if (node.parentNode === el.messages && node.getBoundingClientRect().bottom > viewportTop
        && node.getBoundingClientRect().top < viewport.bottom) {
        anchor = node;
        anchorOffset = node.getBoundingClientRect().top - viewportTop;
        break;
      }
    }
  }
  // Preserve chronological item order independently of turn-page boundaries.
  // Summary items are not complete transcript entries and must not be mixed in.
  let previous = null;
  const activeKeys = new Set();
  const turnTimes = new Map((state.turns || []).map(turn => [String(turn?.id || ""), turn]));
  for (const unit of codexNativeRenderUnits(state.entries)) {
    const key = unit.key;
    activeKeys.add(key);
    const revision = JSON.stringify(unit.kind === "work" ? unit.rows.map(row => row.item) : unit.item);
    let row = rendered.get(key);
    if (!row || row.revision !== revision) {
      const staging = document.createElement("div");
      if (unit.kind === "work") appendCodexNativeActivity(unit.rows, staging, unit.key);
      else appendCodexNativeItem(unit.item, staging);
      const node = staging.firstChild;
      if (!node) continue;
      node.classList.remove("msg-in");
      node.dataset.i18nIgnore = "";
      if (row?.node.parentNode === el.messages) row.node.replaceWith(node);
      row = { node, revision };
      rendered.set(key, row);
    }
    const reference = previous ? previous.nextSibling : codexNativeHistoryButton?.parentNode === el.messages
      ? codexNativeHistoryButton.nextSibling : el.messages.firstChild;
    if (row.node !== reference) el.messages.insertBefore(row.node, reference);
    previous = row.node;
    // The work log measures a turn from Codex's own start/completion times.
    if (unit.kind === "message" && unit.view?.role === "user") {
      row.user = { turnId: String(unit.turnId || ""), text: codexNativeEchoText(unit.view.text) };
      const record = turnTimes.get(String(unit.turnId || ""));
      const started = normalizedTimestampMs(record?.startedAt);
      const completed = normalizedTimestampMs(record?.completedAt);
      if (started) row.node.dataset.wlStart = String(started);
      if (completed) row.node.dataset.wlEnd = String(completed);
    }
  }
  for (const [key, row] of rendered) {
    if (activeKeys.has(key)) continue;
    row.node?.remove?.();
    rendered.delete(key);
  }
  reconcileCodexNativeEchoes(connection);
  connection.nativeRenderedRevision = true;
  ensureSessionUsageFooter();
  keepSessionUsageAtEnd();
  showCodexNativeHistoryButton();
  layoutWorkLog({ keepScroll: true });
  if (el.taskReplayNote) {
    el.taskReplayNote.textContent = state.error ? tKey("runtime.historyFailed", { detail: state.error })
      : state.itemGapKeys ? tKey("runtime.historyGap") : "";
    el.taskReplayNote.classList.toggle("hidden", !state.error && !state.itemGapKeys);
  }
  if (preserve) {
    el.messages.scrollTop = anchor?.parentNode === el.messages
      ? el.messages.scrollTop + anchor.getBoundingClientRect().top - viewportTop - anchorOffset
      : oldTop + (preserveScroll ? el.messages.scrollHeight - oldHeight : 0);
    updateScrollBottomButton();
  } else scrollBottom();
}

async function loadOlderCodexNativeHistory() {
  const connection = rpc;
  const state = connection?.nativeCodex ? connection.nativeTranscriptState : null;
  if (!state || state.loading || connection.nativeRefreshInFlight || !state.hasMore) return;
  const generation = viewGeneration;
  const controller = new AbortController();
  const isCurrent = () => rpc === connection && generation === viewGeneration;
  connection.nativeHistoryRequest = controller;
  state.loading = true;
  showCodexNativeHistoryButton();
  try {
    const page = await loadCodexNativeTranscript(connection.nativeThreadId, {
      older: true, turnsCursor: state.turnsCursor, itemsCursor: state.itemsCursor,
      signal: controller.signal, isCurrent,
    });
    if (!isCurrent()) return;
    applyCodexNativeTranscriptPage(state, page, { older: true });
    state.olderError = state.error;
    renderCodexNativeSnapshot(connection, { preserveScroll: true });
  } catch (error) {
    if (isCurrent() && error.name !== "AbortError") {
      state.error = String(error.message).slice(0, 128);
      toast(tKey("runtime.historyFailed", { detail: state.error }), true);
    }
  } finally {
    state.loading = false;
    if (connection.nativeHistoryRequest === controller) connection.nativeHistoryRequest = null;
    if (isCurrent()) showCodexNativeHistoryButton();
  }
}

function nativeCodexStatus(thread, observation = null) {
  if (observation?.working === true) return "running";
  const type = String(thread?.status?.type || "idle");
  return type === "systemError" ? "failed" : type === "active" ? "running" : "waiting";
}

function renderCodexNativeApprovals(connection, permissions) {
  if (rpc !== connection || !connection.nativeCodexMutation || !window.stepsembleCodexApprovals) return;
  if (!connection.codexApprovals) {
    const base = apiBase;
    const current = () => rpc === connection && apiBase === base;
    const cards = new Map();
    connection.codexApprovals = window.stepsembleCodexApprovals.createController({
      threadId: connection.nativeThreadId, isCurrent: current,
      request: body => {
        if (!current()) throw new Error("native_thread_mismatch");
        return post("/api/codex/mutation/approval", body);
      },
      onChange: rows => {
        if (!current()) return;
        for (const row of rows) {
          let view = cards.get(row.key);
          if (!view) {
            const shell = makeMsgShell("assistant", "Codex CLI");
            const card = document.createElement("div"); card.className = "agent-approval-card";
            const title = document.createElement("strong"); title.textContent = browseText("Codex permission required");
            const summary = document.createElement("p"); summary.textContent = row.summary;
            const details = document.createElement("pre"); details.className = "agent-approval-details";
            details.textContent = row.details;
            const state = document.createElement("small"); state.setAttribute("role", "status");
            const actions = document.createElement("div"); actions.className = "agent-approval-actions";
            const buttons = [];
            for (const [decision, label] of [["approved", row.scope === "run" ? "Allow for this turn" : "Allow once"], ["denied", "Reject"]]) {
              const button = document.createElement("button"); button.type = "button"; button.className = decision === "denied" ? "btn ghost" : "btn primary";
              button.textContent = browseText(label);
              button.addEventListener("click", () => void connection.codexApprovals.decide(row.key, decision));
              actions.appendChild(button); buttons.push(button);
            }
            card.append(title, summary, details, state, actions); shell.bubble.appendChild(card);
            view = { state, buttons, wrap: shell.wrap }; cards.set(row.key, view);
          }
          const labels = { pending: "Waiting for your decision", sending: "Sending decision…", written: "Decision sent; waiting for Codex", closed: "Request closed by Codex", uncertain: "Delivery uncertain; check Codex before retrying" };
          view.state.textContent = browseText(row.available === false ? "Approval status unavailable; reconnect to continue"
            : !row.reviewable && row.state === "pending" ? "Full permission details unavailable; use the native client to allow" : labels[row.state] || labels.uncertain);
          view.buttons.forEach((button, index) => { button.disabled = row.state !== "pending" || row.available === false || index === 0 && !row.reviewable; });
        }
        const keep = new Set(rows.map(row => row.key));
        for (const [key, view] of cards) if (!keep.has(key)) { view.wrap?.remove(); cards.delete(key); }
        keepSessionUsageAtEnd();
      },
    });
  }
  connection.codexApprovals.sync(permissions);
}

async function refreshCodexNativeSnapshot(connection, { initial = false } = {}) {
  if (!connection || rpc !== connection || !connection.nativeCodex) return;
  if (connection.nativeTranscriptState.loading || connection.nativeRefreshInFlight) return;
  const generation = viewGeneration;
  const controller = new AbortController();
  const isCurrent = () => rpc === connection && generation === viewGeneration;
  connection.nativeHistoryRequest = controller;
  connection.nativeRefreshInFlight = true;
  showCodexNativeHistoryButton();
  try {
    const [page, mutation] = await Promise.all([
      loadCodexNativeTranscript(connection.nativeThreadId, { signal: controller.signal, isCurrent }),
      connection.nativeCodexMutation
        ? api(`/api/codex/mutation?threadId=${encodeURIComponent(connection.nativeThreadId)}`, { signal: controller.signal })
          .catch(() => ({ unavailable: true }))
        : null,
    ]);
    if (!isCurrent()) return;
    // Leave an older-page error visible until that page is successfully retried.
    applyCodexNativeTranscriptPage(connection.nativeTranscriptState, page);
    connection.nativeTranscriptState.goalAvailable = page.goalAvailable;
    connection.nativeTranscriptState.goal = page.goal || null;
    connection.nativeTranscriptState.observation = page.observation || null;
    if (!initial) connection.nativeTranscriptState.error ||= connection.nativeTranscriptState.olderError;
    const thread = page.thread;
    const observation = page.observation || null;
    const status = nativeCodexStatus(thread, observation);
    const normalizeNativeTime = (value) => window.stepsembleSessionUtils?.normalizeTimestampMs?.(value) || Number(value) || 0;
    const activeTurn = connection.nativeTranscriptState.turns.find(turn => turn?.status === "inProgress") || null;
    const activeTurnStart = normalizeNativeTime(observation?.startedAt) || normalizeNativeTime(activeTurn?.startedAt);
    if (status === "running") {
      if (activeTurnStart) connection.runStartedAt = activeTurnStart;
      else if (connection.taskStatus !== "running") connection.runStartedAt = Date.now();
      connection.runEndedAt = null;
    } else if (connection.taskStatus === "running" && !connection.runEndedAt) {
      connection.runEndedAt = normalizeNativeTime(activeTurn?.completedAt) || Date.now();
    }
    applyGenericTaskSnapshot({ id: connection.sid, taskId: connection.sid, agentId: "codex", nativeCodex: true, nativeCodexMutation: connection.nativeCodexMutation,
      nativeThreadId: connection.nativeThreadId, nativeSessionId: thread?.sessionId || connection.nativeThreadId,
      name: connection.name, cwd: thread?.cwd || connection.cwd, status,
      startedAt: normalizeNativeTime(connection.runStartedAt), endedAt: normalizeNativeTime(connection.runEndedAt),
      lastActivityAt: normalizeNativeTime(observation?.lastActivityAt) || normalizeNativeTime(thread?.updatedAt) || Date.now() });
    renderCodexNativeSnapshot(connection);
    renderCodexNativeRunState(connection);
    if (connection.nativeCodexMutation) {
      if (mutation?.unavailable) {
        connection.codexApprovals?.unavailable();
        if (el.taskReplayNote) {
          el.taskReplayNote.textContent = browseText("Approval status unavailable; reconnect to continue");
          el.taskReplayNote.classList.remove("hidden");
        }
      } else renderCodexNativeApprovals(connection, mutation?.pendingApprovals);
    }
    void syncNativeContext(connection);
    connection.nativeLoading = false;
    connection.connectionLost = false;
    syncGenericInputState();
    if (codexNativePollTimer) { clearInterval(codexNativePollTimer); codexNativePollTimer = null; }
    // Keep idle native chats observable too: another client can begin a turn
    // or request approval while this phone remains on the same conversation.
    codexNativePollTimer = setInterval(() => {
      if (!document.hidden) void refreshCodexNativeSnapshot(connection);
    }, status === "running" ? 2500 : 8000);
  } catch (error) {
    if (!isCurrent() || error.name === "AbortError") return;
    connection.nativeLoading = false;
    connection.connectionLost = true;
    syncGenericInputState();
    if (initial) throw error;
  } finally {
    connection.nativeRefreshInFlight = false;
    if (connection.nativeHistoryRequest === controller) connection.nativeHistoryRequest = null;
    if (isCurrent()) showCodexNativeHistoryButton();
  }
}

async function openCodexNativeTask(task, generationOverride = null) {
  if (!task) return;
  const nativeThreadId = String(task.nativeThreadId || task.nativeSessionId || task.id || "").replace(/^codex:/, "");
  if (!nativeThreadId) return;
  const cwd = task.cwd || "";
  const name = task.name || "Codex";
  rememberLastAgentTask(task.id || `codex:${nativeThreadId}`);
  beginDraftScope({ cwd, name });
  const generation = generationOverride === null ? ++viewGeneration : generationOverride;
  if (rpc) closeChat(!!(rpc.streaming || rpc.connectionLost));
  resetTaskProgress();
  resetProjectChanges();
  resetComposerSummary();
  currentSessionFile = null;
  currentAgentTaskId = `codex:${nativeThreadId}`;
  updateSessionSelection();
  _lastMsgDate = null;
  lastUserText = "";
  currentSessionCwd = cwd;
  historyState = null;
  removeHistoryLoadButton();
  removeCodexNativeHistoryButton();
  autoScrollPinned = true;
  hideChatEmpty();
  setChatTitle(name);
  setChatAgent("codex");
  el.chatSub.dataset.base = cwd;
  el.chatSub.textContent = cwd;
  resetLiveUsage();
  el.messages.innerHTML = "";
  resetSessionUsage();
  ensureSessionUsageFooter();
  if (!isDesktop()) { el.viewList.classList.add("hidden"); syncSessionListPolling(); }
  el.viewChat.classList.remove("hidden");
  void refreshProjectChanges({ background: true });
  rpc = {
    sid: `codex:${nativeThreadId}`,
    generic: true,
    nativeCodex: true,
    nativeCodexMutation: task.mutation === "native_api" || task.readOnly === false,
    nativeThreadId,
    codexModel: null,
    codexModelSelected: false,
    codexModels: null,
    codexModelsLoaded: false,
    codexEffort: "off",
    nativeLoading: true,
    nativeRenderedRevision: null,
    nativeTranscriptState: createCodexNativeTranscriptState(),
    nativeRenderedItems: new Map(),
    nativeRefreshInFlight: false,
    genericOutputNode: null,
    genericTerminalNotice: null,
    streamReady: true,
    connectionLost: false,
    stopPending: false,
    initialRetryAttempted: false,
    taskStatus: "waiting",
    agentId: "codex",
    agentLabel: "Codex CLI",
    name,
    cwd,
    runStartedAt: normalizedTimestampMs(task.startedAt) || Date.now(),
    runEndedAt: normalizedTimestampMs(task.endedAt) || null,
  };
  const connection = rpc;
  codexNativePollTimer = null;
  try {
    await retryCodexNativeTransient(async (attempt) => {
      if (attempt > 0) connection.initialRetryAttempted = true;
      await refreshCodexNativeSnapshot(connection, { initial: true });
    });
    if (rpc !== connection || generation !== viewGeneration) return;
    syncGenericInputState();
  } catch (error) {
    if (rpc === connection && generation === viewGeneration) {
      toast(tKey("runtime.openChatFailed", { detail: error.message }), true);
      closeChat(true);
      showList();
    }
  }
}

async function openOpenCodeNativeTask(task, generationOverride = null) {
  if (!task) return;
  const nativeSessionId = String(task.nativeSessionId || task.id || "").replace(/^opencode:/, "");
  if (!nativeSessionId) return;
  const cwd = task.cwd || "";
  const name = task.name || "OpenCode";
  // Imported OpenCode sessions are view-only when their task is historical.
  // They can still be reconciled by session id even if the original cwd is
  // no longer an allowed project folder; active sessions keep live controls.
  const nativeOpenCodeReadOnly = task.readOnly === true
    || task.idleNativeSession === true
    || task.status === "history"
    || (task.history === "native_readonly"
      && ["completed", "failed", "stopped", "orphaned", "detached"].includes(String(task.status || "")));
  rememberLastAgentTask(task.id || `opencode:${nativeSessionId}`);
  beginDraftScope({ cwd, name });
  const generation = generationOverride === null ? ++viewGeneration : generationOverride;
  if (rpc) closeChat(!!(rpc.streaming || rpc.connectionLost));
  resetTaskProgress();
  resetProjectChanges();
  resetComposerSummary();
  currentSessionFile = null;
  currentAgentTaskId = `opencode:${nativeSessionId}`;
  updateSessionSelection();
  _lastMsgDate = null;
  lastUserText = "";
  currentSessionCwd = cwd;
  historyState = null;
  removeHistoryLoadButton();
  autoScrollPinned = true;
  hideChatEmpty();
  setChatTitle(name);
  setChatAgent("opencode");
  el.chatSub.dataset.base = cwd;
  el.chatSub.textContent = cwd;
  resetLiveUsage();
  el.messages.innerHTML = "";
  resetSessionUsage();
  ensureSessionUsageFooter();
  if (!isDesktop()) { el.viewList.classList.add("hidden"); syncSessionListPolling(); }
  el.viewChat.classList.remove("hidden");
  void refreshProjectChanges({ background: true });
  rpc = {
    sid: `opencode:${nativeSessionId}`,
    generic: true,
    nativeOpenCode: true,
    nativeOpenCodeReadOnly,
    nativeHistoryReadonly: nativeOpenCodeReadOnly,
    nativeSessionId,
    openCodeModel: null,
    openCodeModelSelected: false,
    openCodeModels: [],
    openCodeModelsLoadedAt: 0,
    openCodeModelsRequest: null,
    openCodeContextSnapshot: null,
    // A fast back→reopen can arrive while the OpenCode server is finishing
    // the previous reconcile. One bounded retry keeps a transient upstream
    // 409/5xx from collapsing the chat back to the empty list view.
    initialRetryAttempted: false,
    nativeLoading: true,
    nativeRenderedRevision: null,
    genericOutputNode: null,
    genericTerminalNotice: null,
    streamReady: false,
    connectionLost: false,
    stopPending: false,
    taskStatus: "waiting",
    agentId: "opencode",
    agentLabel: "OpenCode",
    name,
    cwd,
    runStartedAt: normalizedTimestampMs(task.startedAt) || Date.now(),
    runEndedAt: null,
  };
  const connection = rpc;
  openCodeNativePollTimer = null;
  try {
    await refreshOpenCodeNativeSnapshot(connection, { initial: true });
    if (rpc !== connection || generation !== viewGeneration) return;
    connection.streamReady = true;
    connection.connectionLost = false;
    syncGenericInputState();
    if (openCodeNativePollTimer) clearInterval(openCodeNativePollTimer);
    openCodeNativePollTimer = setInterval(() => void refreshOpenCodeNativeSnapshot(connection), 2500);
  } catch (error) {
    if (rpc === connection && generation === viewGeneration && !connection.initialRetryAttempted) {
      connection.initialRetryAttempted = true;
      await new Promise(resolve => setTimeout(resolve, 120));
      if (rpc !== connection || generation !== viewGeneration) return;
      try {
        await refreshOpenCodeNativeSnapshot(connection, { initial: true });
        if (rpc !== connection || generation !== viewGeneration) return;
        connection.streamReady = true;
        connection.connectionLost = false;
        syncGenericInputState();
        if (openCodeNativePollTimer) clearInterval(openCodeNativePollTimer);
        openCodeNativePollTimer = setInterval(() => void refreshOpenCodeNativeSnapshot(connection), 2500);
        return;
      } catch (retryError) {
        error = retryError;
      }
    }
    if (rpc === connection && generation === viewGeneration) {
      toast(tKey("runtime.openChatFailed", { detail: error.message }), true);
      closeChat(true);
      showList();
    }
  }
}

function resetStructuredTranscriptPresentation(connection) {
  if (!connection) return;
  connection.structuredToolCards = new Map();
  connection.structuredThinking = null;
  connection.genericOutputNode = null;
}

function appendStructuredThinking(connection, value, label) {
  const text = String(value || "");
  if (!text) return;
  let state = connection.structuredThinking;
  if (!state?.block?.isConnected) {
    const shell = makeMsgShell("assistant", label);
    const node = makeThinking("");
    const block = node.querySelector(".thinking-block");
    shell.bubble.appendChild(node);
    state = { wrap: shell.wrap, node, block };
    connection.structuredThinking = state;
  }
  if (state.block) state.block.textContent += text;
  connection.genericOutputNode = null;
}

function appendStructuredTool(connection, tool, label, fallbackKey) {
  if (!tool) return;
  const key = String(tool.id || fallbackKey || `tool-${connection.structuredToolCards?.size || 0}`);
  connection.structuredToolCards ||= new Map();
  let card = connection.structuredToolCards.get(key);
  const output = tool.output || (tool.running ? null : tool.isError ? "（沒有收到工具輸出）" : "（無輸出）");
  if (!card?.isConnected) {
    const shell = makeMsgShell("assistant", label);
    card = makeToolCard(tool.name, tool.args, output, tool.isError, tool.running);
    card.classList.add("native-tool-card");
    card.dataset.nativeToolId = key;
    shell.bubble.appendChild(card);
    connection.structuredToolCards.set(key, card);
  } else {
    const previous = card.__tool || {};
    const nextName = tool.name === "tool" && previous.name ? previous.name : tool.name;
    const nextArgs = tool.args && Object.keys(tool.args).length ? tool.args : previous.args;
    card.__tool = { name: nextName, args: nextArgs };
    setToolCardState(card, { running: tool.running, isError: tool.isError, text: output });
  }
  // Any prose emitted after this call belongs below the tool row instead of
  // being appended to the response bubble that preceded it.
  connection.genericOutputNode = null;
  connection.structuredThinking = null;
}

function renderAgentProtocolUpdate(connection, update, label, fallbackKey) {
  const view = agentTranscriptPresentation.acpUpdate(update);
  if (!view) return;
  if (view.kind === "message_delta") {
    connection.structuredThinking = null;
    appendGenericOutput(view.text, "stdout");
  } else if (view.kind === "thinking_delta") {
    appendStructuredThinking(connection, view.text, label);
  } else if (view.kind === "tool") {
    appendStructuredTool(connection, view.tool, label, fallbackKey);
  }
}

function renderGrokAcpEvents(connection, events, { replace = false } = {}) {
  if (rpc !== connection || !connection?.nativeGrokAcp) return;
  const rows = Array.isArray(events) ? events : [];
  if (replace) { el.messages.innerHTML = ""; connection.grokEventIndex = 0; resetStructuredTranscriptPresentation(connection); }
  for (let index = connection.grokEventIndex || 0; index < rows.length; index += 1) {
    renderAgentProtocolUpdate(connection, rows[index]?.update, connection.agentLabel || "Grok Build", `grok-${index}`);
  }
  connection.grokEventIndex = rows.length;
  keepSessionUsageAtEnd();
  scrollBottom();
}

function renderGrokAcpPermissions(connection, permissions) {
  if (rpc !== connection || !connection?.nativeGrokAcp) return;
  for (const permission of Array.isArray(permissions) ? permissions : []) {
    const id = String(permission?.id ?? "");
    if (!id || [...(el.messages?.querySelectorAll("[data-grok-permission]") || [])]
      .some(node => node.dataset.grokPermission === id)) continue;
    const shell = makeMsgShell("assistant", connection.agentLabel || "Grok Build");
    const card = document.createElement("div");
    card.className = "agent-approval-card";
    card.dataset.grokPermission = id;
    const title = document.createElement("strong");
    title.textContent = "Grok Build permission required";
    const toolCall = permission.params?.toolCall || {};
    const summary = document.createElement("p");
    summary.textContent = String(toolCall.title || permission.params?.method || "The agent is requesting permission.").slice(0, 1000);
    const state = document.createElement("small");
    state.dataset.role = "approval-state";
    state.textContent = "Waiting for your decision";
    const actions = document.createElement("div");
    actions.className = "agent-approval-actions";
    const options = Array.isArray(permission.params?.options) ? permission.params.options : [];
    for (const option of options) {
      const optionId = String(option?.optionId || "");
      const label = String(option?.name || optionId || "Choose").slice(0, 120);
      if (!optionId || !label) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = String(option?.kind || "").startsWith("reject") ? "btn ghost" : "btn primary";
      button.textContent = label;
      button.addEventListener("click", async () => {
        button.disabled = true;
        actions.querySelectorAll("button").forEach(item => { item.disabled = true; });
        try {
          await post("/api/grok/acp/permission", { requestId: permission.id,
            result: { outcome: { outcome: "selected", optionId } } });
          state.textContent = `Decision sent: ${label} · waiting for Grok confirmation`;
        } catch (error) {
          state.textContent = error?.message || "Could not record the decision";
          actions.querySelectorAll("button").forEach(item => { item.disabled = false; });
        }
      });
      actions.appendChild(button);
    }
    if (!actions.children.length) {
      state.textContent = "No valid ACP options were provided; request is blocked.";
    }
    card.append(title, summary, state, actions);
    shell.bubble.appendChild(card);
  }
}

async function refreshGrokAcpSnapshot(connection, { initial = false } = {}) {
  if (!connection || rpc !== connection || !connection.nativeGrokAcp) return;
  if (connection.nativeRefreshInFlight) return;
  connection.nativeRefreshInFlight = true;
  try {
    const [snapshot, pending] = await Promise.all([
      api(`/api/grok/acp/events?sessionId=${encodeURIComponent(connection.nativeSessionId)}`),
      api("/api/grok/acp/pending"),
    ]);
    if (rpc !== connection) return;
    renderGrokAcpEvents(connection, snapshot?.events, { replace: initial });
    renderGrokAcpPermissions(connection, pending?.permissions);
    connection.nativeLoading = false;
    connection.connectionLost = false;
    connection.taskStatus = snapshot?.adapter?.sessionReady ? "waiting" : connection.taskStatus;
    syncGenericInputState();
  } catch {
    if (rpc !== connection) return;
    connection.nativeLoading = false;
    connection.connectionLost = true;
    syncGenericInputState();
  } finally {
    connection.nativeRefreshInFlight = false;
  }
}

async function openGrokAcpTask(task, generationOverride = null) {
  if (!task) return;
  const nativeSessionId = String(task.nativeSessionId || task.id || "").replace(/^grok-build:/, "");
  if (!nativeSessionId) return;
  const cwd = task.cwd || "";
  const name = task.name || "Grok Build";
  rememberLastAgentTask(task.id || `grok-build:${nativeSessionId}`);
  beginDraftScope({ cwd, name });
  const generation = generationOverride === null ? ++viewGeneration : generationOverride;
  if (rpc) closeChat(!!(rpc.streaming || rpc.connectionLost));
  resetTaskProgress(); resetProjectChanges(); resetComposerSummary();
  currentSessionFile = null; currentAgentTaskId = `grok-build:${nativeSessionId}`; updateSessionSelection();
  _lastMsgDate = null; lastUserText = ""; currentSessionCwd = cwd; historyState = null; removeHistoryLoadButton();
  autoScrollPinned = true; hideChatEmpty(); setChatTitle(name); setChatAgent("grok-build");
  el.chatSub.dataset.base = cwd; el.chatSub.textContent = cwd; resetLiveUsage(); el.messages.innerHTML = ""; resetSessionUsage(); ensureSessionUsageFooter();
  if (!isDesktop()) { el.viewList.classList.add("hidden"); syncSessionListPolling(); }
  el.viewChat.classList.remove("hidden"); void refreshProjectChanges({ background: true });
  rpc = { sid: `grok-build:${nativeSessionId}`, generic: true, nativeGrokAcp: true, nativeSessionId,
    nativeLoading: true, connectionLost: false, stopPending: false, streamReady: true, taskStatus: "waiting",
    genericOutputNode: null, genericTerminalNotice: null, genericInputEchoes: [], grokEventIndex: 0,
    agentId: "grok-build", agentLabel: "Grok Build", name, cwd, runStartedAt: normalizedTimestampMs(task.startedAt) || Date.now(), runEndedAt: null };
  const connection = rpc;
  grokAcpPollTimer = null;
  try {
    await refreshGrokAcpSnapshot(connection, { initial: true });
    if (rpc !== connection || generation !== viewGeneration) return;
    grokAcpPollTimer = setInterval(() => void refreshGrokAcpSnapshot(connection), 2000);
    syncGenericInputState();
  } catch (error) {
    if (rpc === connection && generation === viewGeneration) { toast(tKey("runtime.openChatFailed", { detail: error.message }), true); closeChat(true); showList(); }
  }
}

function renderClaudeStructuredEvents(connection, events, { replace = false } = {}) {
  if (rpc !== connection || !connection?.nativeClaudeStructured) return;
  const rows = Array.isArray(events) ? events : [];
  if (replace) {
    el.messages.innerHTML = "";
    // The output node may belong to the old detached transcript after a
    // replace. Drop it together with the renderer so the next turn starts at
    // a fresh, attached node.
    rpc.genericOutputNode = null;
    connection.claudeEventIndex = 0;
    connection.claudeOutputStart = null;
    resetStructuredTranscriptPresentation(connection);
    connection.claudeRenderer?.reset?.();
  }
  const renderer = connection.claudeRenderer
    || (claudeStructuredRendering?.createRenderer ? claudeStructuredRendering.createRenderer() : null);
  connection.claudeRenderer = renderer;
  for (let index = connection.claudeEventIndex || 0; index < rows.length; index += 1) {
    const event = rows[index];
    for (const [activityIndex, activity] of agentTranscriptPresentation.claudeEvent(event).entries()) {
      if (activity.kind === "tool") appendStructuredTool(connection, activity.tool, connection.agentLabel || "Claude Code", `claude-${index}-${activityIndex}`);
    }
    const update = renderer?.consume?.(event);
    if (!update?.text) continue;
    if (update.beginTurn || !Number.isSafeInteger(connection.claudeOutputStart)) {
      const current = rpc.genericOutputNode;
      connection.claudeOutputStart = current?.dataset?.stream === "stdout" ? genericOutputText(current).length : 0;
    }
    if (update.mode === "replace") replaceClaudeStructuredOutputTail(connection, update.text);
    else appendGenericOutput(update.text, "stdout");
  }
  connection.claudeEventIndex = rows.length;
  keepSessionUsageAtEnd(); scrollBottom();
}

async function loadClaudeNativeHistory(connection) {
  if (connection?.nativeClaudeStructured && rpc === connection) {
    // Keep a tiny, non-sensitive diagnostic marker on the message viewport.
    // It makes a failed history read distinguishable from an empty transcript
    // without exposing paths, prompts, or credentials.
    el.messages.dataset.claudeHistory = "loading";
  }
  // A structured Claude task can be returned as `waiting`, `history`, or
  // `available` depending on whether the native adapter has already been
  // hydrated. The transcript itself is the source of truth, so do not make
  // rendering depend on one lifecycle label.
  if (!connection?.claudeHistoryCandidate || connection.claudeHistoryLoaded || !connection.nativeSessionId) return false;
  const taskId = `claude-history:${connection.nativeSessionId}`;
  try {
    const result = await api(`/api/native-history/session?taskId=${encodeURIComponent(taskId)}`);
    if (rpc !== connection || !Array.isArray(result?.messages) || !result.messages.length) {
      connection.claudeHistoryLoadState = "empty";
      if (rpc === connection) el.messages.dataset.claudeHistory = "empty";
      return false;
    }
    const staging = document.createElement("div");
    let sliceStarted = performance.now();
    for (const message of result.messages) {
      if (performance.now() - sliceStarted > 8) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (rpc !== connection) return false;
        sliceStarted = performance.now();
      }
      maybeDateSeparator(message.ts || message.timestamp, staging);
      appendNativeHistoryMessage(message, "claude-code", staging);
    }
    if (rpc !== connection) return false;
    const fragment = document.createDocumentFragment();
    while (staging.firstChild) fragment.appendChild(staging.firstChild);
    el.messages.appendChild(fragment);
    connection.claudeHistoryLoaded = true;
    connection.claudeHistoryLoadState = "loaded";
    connection.claudeHistoryMessageCount = result.messages.length;
    el.messages.dataset.claudeHistory = "loaded";
    el.messages.dataset.claudeHistoryCount = String(result.messages.length);
    ensureSessionUsageFooter();
    keepSessionUsageAtEnd();
    scrollBottom(true);
    return true;
  } catch (error) {
    // A Claude history file can be absent while the live session is still
    // valid (for example during its first turn). Keep the native channel
    // usable and let the structured stream remain the source of truth.
    connection.claudeHistoryLoadState = "unavailable";
    connection.claudeHistoryLoadError = String(error?.message || "history unavailable").slice(0, 160);
    if (rpc === connection) {
      el.messages.dataset.claudeHistory = "unavailable";
      console.warn("[stepsemble] Claude native history unavailable", connection.claudeHistoryLoadError);
    }
    return false;
  }
}

function renderClaudeStructuredPermissions(connection, permissions) {
  if (rpc !== connection || !connection?.nativeClaudeStructured) return;
  for (const permission of Array.isArray(permissions) ? permissions : []) {
    const id = String(permission?.requestId || permission?.request_id || permission?.eventId || "");
    if (!id || [...(el.messages?.querySelectorAll("[data-claude-permission]") || [])]
      .some(node => node.dataset.claudePermission === id)) continue;
    const shell = makeMsgShell("assistant", connection.agentLabel || "Claude Code");
    const card = document.createElement("div");
    card.className = "agent-approval-card";
    card.dataset.claudePermission = id;
    const title = document.createElement("strong");
    title.textContent = "Claude Code permission required";
    const summary = document.createElement("p");
    const request = permission?.request && typeof permission.request === "object" ? permission.request : permission;
    const tool = String(request?.tool_name || request?.toolName || permission?.tool || permission?.name || "tool");
    const description = String(request?.description || permission?.message || "Claude Code requested permission.");
    let inputSummary = "";
    try { inputSummary = request?.input && typeof request.input === "object" ? `\n${JSON.stringify(request.input).slice(0, 1800)}` : ""; } catch {}
    summary.textContent = `${tool} · ${description}`.slice(0, 1000) + inputSummary;
    const state = document.createElement("small");
    state.dataset.role = "approval-state";
    state.textContent = permission?.decision ? `Decision sent: ${permission.decision} · waiting for Claude` : "Waiting for your decision";
    const actions = document.createElement("div");
    actions.className = "agent-approval-actions";
    for (const [decision, label] of [["allow", "Allow"], ["deny", "Deny"]]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = decision === "deny" ? "btn ghost" : "btn primary";
      button.textContent = label;
      button.disabled = !!permission?.decision;
      button.addEventListener("click", async () => {
        actions.querySelectorAll("button").forEach(item => { item.disabled = true; });
        try {
          const result = await post("/api/claude/structured/permission", {
            sessionId: connection.nativeSessionId, requestId: id, decision,
          });
          permission.decision = decision;
          state.textContent = `Decision sent: ${decision} · waiting for Claude`;
          if (result?.kind !== "written") throw new Error("Claude did not accept the permission response");
        } catch (error) {
          state.textContent = error?.message || "Could not record the decision";
          actions.querySelectorAll("button").forEach(item => { item.disabled = false; });
        }
      });
      actions.appendChild(button);
    }
    card.append(title, summary, state, actions);
    shell.bubble.appendChild(card);
  }
}

async function refreshClaudeStructuredSnapshot(connection, { initial = false } = {}) {
  if (!connection || rpc !== connection || !connection.nativeClaudeStructured) return;
  if (connection.nativeRefreshInFlight) return;
  connection.nativeRefreshInFlight = true;
  try {
    const [snapshot, pending] = await Promise.all([
      api(`/api/claude/structured/events?sessionId=${encodeURIComponent(connection.nativeSessionId)}`),
      api(`/api/claude/structured/pending?sessionId=${encodeURIComponent(connection.nativeSessionId)}`),
    ]);
    if (rpc !== connection) return;
    renderClaudeStructuredEvents(connection, snapshot?.events, { replace: initial });
    renderClaudeStructuredPermissions(connection, pending?.permissions);
    connection.nativeLoading = false; connection.connectionLost = false;
    // The structured stream is polled rather than kept as a browser-owned
    // SSE connection. Reconcile the authoritative adapter status on every
    // poll so a resumed/native session cannot look idle forever, and so the
    // task center receives the real lifecycle timestamps and native id.
    const status = snapshot?.status || {};
    connection.taskStatus = status.closed ? "stopped" : status.failed ? "failed"
      : status.state === "running" ? "running" : "waiting";
    applyGenericTaskSnapshot({
      id: connection.sid,
      taskId: connection.sid,
      agentId: "claude-code",
      status: connection.taskStatus,
      nativeClaudeStructured: true,
      nativeSessionId: status.nativeSessionId || connection.nativeSessionId,
      startedAt: status.startedAt,
      lastActivityAt: status.lastActivityAt,
      endedAt: status.closed ? (status.lastActivityAt || Date.now()) : undefined,
      nativeStatus: status,
    });
    void syncNativeContext(connection);
    syncGenericInputState();
  } catch {
    if (rpc !== connection) return;
    connection.nativeLoading = false; connection.connectionLost = true; syncGenericInputState();
  } finally {
    connection.nativeRefreshInFlight = false;
  }
}

async function syncClaudeStructuredModelCatalog(connection = rpc, { force = false } = {}) {
  if (!connection?.nativeClaudeStructured || rpc !== connection || !connection.nativeSessionId) return null;
  if (!force && connection.claudeModelsLoaded && Array.isArray(connection.claudeModels)) return connection.claudeModels;
  const result = await api(`/api/claude/structured/models?sessionId=${encodeURIComponent(connection.nativeSessionId)}`);
  if (rpc !== connection) return null;
  const models = (Array.isArray(result?.models) ? result.models : []).map(normalizeClaudeModel).filter(Boolean);
  connection.claudeModels = models;
  connection.claudeModelsLoaded = true;
  const current = claudeModelFromCatalog(models, result?.currentModel)
    || models.find(model => model.id === "default")
    || models[0]
    || null;
  if (current && !connection.claudeModelSelected) {
    connection.claudeModel = current;
    composerModelContextWindow = positiveFinite(current.contextWindow);
    updateComposerSummary(current.name || current.id, undefined);
  }
  connection.claudeEffort = String(result?.currentEffort || connection.claudeEffort || "auto").toLowerCase();
  syncNativeThinkingSelect(connection);
  return models;
}

async function openClaudeStructuredTask(task, generationOverride = null) {
  if (!task) return;
  const nativeSessionId = String(task.nativeSessionId || task.id || task.taskId || "").replace(/^claude-code:/, "");
  if (!nativeSessionId) return;
  const cwd = task.cwd || ""; const name = task.name || "Claude Code";
  if (task.needsLoad === true) {
    const generation = generationOverride === null ? ++viewGeneration : generationOverride;
    if (rpc) closeChat(true);
    try {
      const result = await post("/api/agent/open", { agentId: "claude-code", cwd, name, resumeSessionId: nativeSessionId });
      if (result?.kind === "claude-structured" || result?.nativeClaudeStructured === true) {
        return openClaudeStructuredTask({ ...result, needsLoad: false }, generation);
      }
      if (result) return openGenericTask(result);
      throw new Error("Claude resume returned no task");
    } catch (error) {
      if (generation === viewGeneration) { toast(tKey("runtime.openChatFailed", { detail: error.message }), true); showList(); }
    }
    return;
  }
  rememberLastAgentTask(task.id || `claude-code:${nativeSessionId}`); beginDraftScope({ cwd, name });
  const generation = generationOverride === null ? ++viewGeneration : generationOverride;
  if (rpc) closeChat(!!(rpc.streaming || rpc.connectionLost));
  resetTaskProgress(); resetProjectChanges(); resetComposerSummary(); currentSessionFile = null;
  currentAgentTaskId = `claude-code:${nativeSessionId}`; updateSessionSelection(); _lastMsgDate = null; lastUserText = ""; currentSessionCwd = cwd;
  historyState = null; removeHistoryLoadButton(); autoScrollPinned = true; hideChatEmpty(); setChatTitle(name); setChatAgent("claude-code");
  el.chatSub.dataset.base = cwd; el.chatSub.textContent = cwd; resetLiveUsage(); el.messages.innerHTML = ""; resetSessionUsage(); ensureSessionUsageFooter();
  if (!isDesktop()) { el.viewList.classList.add("hidden"); syncSessionListPolling(); }
  el.viewChat.classList.remove("hidden"); void refreshProjectChanges({ background: true });
  rpc = { sid: `claude-code:${nativeSessionId}`, generic: true, nativeClaudeStructured: true, nativeSessionId, nativeLoading: true,
    connectionLost: false, stopPending: false, streamReady: true, taskStatus: "waiting", genericOutputNode: null, genericTerminalNotice: null,
    genericInputEchoes: [], claudeEventIndex: 0, claudeOutputStart: null, claudeEffort: "auto",
    // Native Claude transcript discovery is independent from the live
    // adapter lifecycle. A newly opened session may still be labelled
    // `waiting` while its JSONL transcript already contains prior turns.
    claudeHistoryCandidate: task.nativeHistoryReadonly !== true, claudeHistoryLoaded: false,
    claudeRenderer: claudeStructuredRendering?.createRenderer?.() || null, claudeModel: null, claudeModelSelected: false,
    claudeModels: null, claudeModelsLoaded: false, agentId: "claude-code", agentLabel: "Claude Code", name, cwd,
    runStartedAt: normalizedTimestampMs(task.startedAt) || Date.now(), runEndedAt: null };
  const connection = rpc; claudeStructuredPollTimer = null;
  try {
    await refreshClaudeStructuredSnapshot(connection, { initial: true });
    if (rpc !== connection || generation !== viewGeneration) return;
    await loadClaudeNativeHistory(connection);
    if (rpc !== connection || generation !== viewGeneration) return;
    // Hydrate the native catalog before enabling the composer. This performs
    // the control handshake once and exposes model/effort controls before the
    // first prompt can be submitted.
    await syncClaudeStructuredModelCatalog(connection);
    if (rpc !== connection || generation !== viewGeneration) return;
    claudeStructuredPollTimer = setInterval(() => void refreshClaudeStructuredSnapshot(connection), 2000); syncGenericInputState();
  } catch (error) {
    if (rpc === connection && generation === viewGeneration) { toast(tKey("runtime.openChatFailed", { detail: error.message }), true); closeChat(true); showList(); }
  }
}

function acpAgentLabel(connection) {
  return connection?.agentLabel || agentConnectorLabel(connection?.acpAgentId || "agent");
}

function renderAgentClientProtocolEvents(connection, events, { replace = false } = {}) {
  if (rpc !== connection || !connection?.nativeAcp) return;
  const rows = Array.isArray(events) ? events : [];
  if (replace) { el.messages.innerHTML = ""; connection.acpEventIndex = 0; resetStructuredTranscriptPresentation(connection); }
  for (let index = connection.acpEventIndex || 0; index < rows.length; index += 1) {
    renderAgentProtocolUpdate(connection, rows[index]?.update || {}, acpAgentLabel(connection), `acp-${index}`);
  }
  connection.acpEventIndex = rows.length;
  keepSessionUsageAtEnd(); scrollBottom();
}

function renderAgentClientProtocolPermissions(connection, permissions) {
  if (rpc !== connection || !connection?.nativeAcp) return;
  for (const permission of Array.isArray(permissions) ? permissions : []) {
    const id = String(permission?.id ?? "");
    if (!id || [...(el.messages?.querySelectorAll("[data-acp-permission]") || [])].some(node => node.dataset.acpPermission === id)) continue;
    const shell = makeMsgShell("assistant", acpAgentLabel(connection));
    const card = document.createElement("div");
    card.className = "agent-approval-card";
    card.dataset.acpPermission = id;
    const title = document.createElement("strong"); title.textContent = `${acpAgentLabel(connection)} permission required`;
    const toolCall = permission.params?.toolCall || {};
    const summary = document.createElement("p"); summary.textContent = String(toolCall.title || toolCall.name || permission.params?.method || "The agent is requesting permission.").slice(0, 1000);
    const state = document.createElement("small"); state.dataset.role = "approval-state"; state.textContent = "Waiting for your decision";
    const actions = document.createElement("div"); actions.className = "agent-approval-actions";
    for (const option of Array.isArray(permission.params?.options) ? permission.params.options : []) {
      const optionId = String(option?.optionId || ""); const label = String(option?.name || optionId || "Choose").slice(0, 120);
      if (!optionId || !label) continue;
      const button = document.createElement("button"); button.type = "button";
      button.className = String(option?.kind || "").startsWith("reject") ? "btn ghost" : "btn primary"; button.textContent = label;
      button.addEventListener("click", async () => {
        actions.querySelectorAll("button").forEach(item => { item.disabled = true; });
        try {
          await post(`/api/${connection.acpAgentId}/acp/permission`, { requestId: permission.id, result: { outcome: { outcome: "selected", optionId } } });
          state.textContent = `Decision sent: ${label} · waiting for ${acpAgentLabel(connection)} confirmation`;
        } catch (error) {
          state.textContent = error?.message || "Could not record the decision";
          actions.querySelectorAll("button").forEach(item => { item.disabled = false; });
        }
      });
      actions.appendChild(button);
    }
    if (!actions.children.length) state.textContent = "No valid ACP options were provided; request is blocked.";
    card.append(title, summary, state, actions); shell.bubble.appendChild(card);
  }
}

async function refreshAgentClientProtocolSnapshot(connection, { initial = false } = {}) {
  if (!connection || rpc !== connection || !connection.nativeAcp) return;
  if (connection.nativeRefreshInFlight) return;
  connection.nativeRefreshInFlight = true;
  try {
    const [snapshot, pending] = await Promise.all([
      api(`/api/${connection.acpAgentId}/acp/events?sessionId=${encodeURIComponent(connection.nativeSessionId)}`),
      api(`/api/${connection.acpAgentId}/acp/pending`),
    ]);
    if (rpc !== connection) return;
    renderAgentClientProtocolEvents(connection, snapshot?.events, { replace: initial });
    renderAgentClientProtocolPermissions(connection, pending?.permissions);
    connection.nativeLoading = false; connection.connectionLost = false;
    connection.taskStatus = "waiting";
    applyGenericTaskSnapshot({ id: connection.sid, taskId: connection.sid, agentId: connection.acpAgentId, nativeAcp: true,
      acpAgentId: connection.acpAgentId, nativeSessionId: connection.nativeSessionId, status: connection.taskStatus,
      nativeStatus: snapshot?.adapter || {} });
    syncGenericInputState();
  } catch {
    if (rpc !== connection) return;
    connection.nativeLoading = false; connection.connectionLost = true; syncGenericInputState();
  } finally {
    connection.nativeRefreshInFlight = false;
  }
}

async function openAgentClientProtocolTask(task, generationOverride = null) {
  if (!task) return;
  const agentId = String(task.acpAgentId || task.agentId || "");
  if (!agentId || !["cline", "kilo", "hermes"].includes(agentId)) return;
  const nativeSessionId = String(task.nativeSessionId || task.id || task.taskId || "").replace(new RegExp(`^${agentId}:`), "");
  if (!nativeSessionId) return;
  const cwd = task.cwd || ""; const name = task.name || agentConnectorLabel(agentId);
  if (task.needsLoad === true) {
    const generation = generationOverride === null ? ++viewGeneration : generationOverride;
    if (rpc) closeChat(true);
    try {
      const result = await post("/api/agent/open", { agentId, cwd, name, resumeSessionId: nativeSessionId });
      if (result?.kind === "acp" || result?.nativeAcp === true) {
        return openAgentClientProtocolTask({ ...result, needsLoad: false }, generation);
      }
      if (result) return openGenericTask(result);
      throw new Error("ACP resume returned no task");
    } catch (error) {
      if (generation === viewGeneration) { toast(tKey("runtime.openChatFailed", { detail: error.message }), true); showList(); }
    }
    return;
  }
  rememberLastAgentTask(task.id || `${agentId}:${nativeSessionId}`); beginDraftScope({ cwd, name });
  const generation = generationOverride === null ? ++viewGeneration : generationOverride;
  if (rpc) closeChat(!!(rpc.streaming || rpc.connectionLost));
  resetTaskProgress(); resetProjectChanges(); resetComposerSummary(); currentSessionFile = null;
  currentAgentTaskId = `${agentId}:${nativeSessionId}`; updateSessionSelection(); _lastMsgDate = null; lastUserText = ""; currentSessionCwd = cwd;
  historyState = null; removeHistoryLoadButton(); autoScrollPinned = true; hideChatEmpty(); setChatTitle(name); setChatAgent(agentId);
  el.chatSub.dataset.base = cwd; el.chatSub.textContent = cwd; resetLiveUsage(); el.messages.innerHTML = ""; resetSessionUsage(); ensureSessionUsageFooter();
  if (!isDesktop()) { el.viewList.classList.add("hidden"); syncSessionListPolling(); }
  el.viewChat.classList.remove("hidden"); void refreshProjectChanges({ background: true });
  rpc = { sid: `${agentId}:${nativeSessionId}`, generic: true, nativeAcp: true, acpAgentId: agentId, nativeSessionId,
    nativeLoading: true, connectionLost: false, stopPending: false, streamReady: true, taskStatus: "waiting", genericOutputNode: null,
    genericTerminalNotice: null, genericInputEchoes: [], acpEventIndex: 0, agentId, agentLabel: agentConnectorLabel(agentId), name, cwd,
    runStartedAt: normalizedTimestampMs(task.startedAt) || Date.now(), runEndedAt: null };
  const connection = rpc; acpPollTimer = null;
  try {
    await refreshAgentClientProtocolSnapshot(connection, { initial: true });
    if (rpc !== connection || generation !== viewGeneration) return;
    acpPollTimer = setInterval(() => void refreshAgentClientProtocolSnapshot(connection), 2000); syncGenericInputState();
  } catch (error) {
    if (rpc === connection && generation === viewGeneration) { toast(tKey("runtime.openChatFailed", { detail: error.message }), true); closeChat(true); showList(); }
  }
}

function renderAntigravityStructuredEvents(connection, events, { replace = false } = {}) {
  if (rpc !== connection || !connection?.nativeAntigravityStructured) return;
  const rows = Array.isArray(events) ? events : [];
  if (replace) { el.messages.innerHTML = ""; connection.antigravityEventIndex = 0; }
  for (let index = connection.antigravityEventIndex || 0; index < rows.length; index += 1) {
    const event = rows[index];
    const text = event?.step_update?.text_delta || event?.step_update?.text || event?.text_delta || event?.result?.response || event?.result?.text || event?.response || event?.text || "";
    if (text) appendGenericOutput(String(text), "stdout");
  }
  connection.antigravityEventIndex = rows.length;
  keepSessionUsageAtEnd(); scrollBottom();
}

function renderAntigravityStructuredPermissions(connection, permissions) {
  if (rpc !== connection || !connection?.nativeAntigravityStructured) return;
  for (const permission of Array.isArray(permissions) ? permissions : []) {
    const id = String(permission?.requestId || permission?.request_id || permission?.eventId || "");
    if (!id || [...(el.messages?.querySelectorAll("[data-antigravity-permission]") || [])]
      .some(node => node.dataset.antigravityPermission === id)) continue;
    const shell = makeMsgShell("assistant", connection.agentLabel || "Google Antigravity");
    const card = document.createElement("div");
    card.className = "agent-approval-card";
    card.dataset.antigravityPermission = id;
    const title = document.createElement("strong");
    title.textContent = "Antigravity permission observed";
    const summary = document.createElement("p");
    summary.textContent = String(permission.message || "Google Antigravity reported a tool that may need approval.").slice(0, 1000);
    const state = document.createElement("small");
    state.dataset.role = "approval-state";
    state.textContent = "The public headless stream does not expose an approval response envelope.";
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "Approve this action in Antigravity's native UI; Stepsemble will not fabricate an ACK.";
    card.append(title, summary, state, note);
    shell.bubble.appendChild(card);
  }
}

async function refreshAntigravityStructuredSnapshot(connection, { initial = false } = {}) {
  if (!connection || rpc !== connection || !connection.nativeAntigravityStructured) return;
  if (connection.nativeRefreshInFlight) return;
  connection.nativeRefreshInFlight = true;
  try {
    const [snapshot, pending] = await Promise.all([
      api(`/api/antigravity/structured/events?sessionId=${encodeURIComponent(connection.nativeSessionId)}`),
      api(`/api/antigravity/structured/pending?sessionId=${encodeURIComponent(connection.nativeSessionId)}`),
    ]);
    if (rpc !== connection) return;
    renderAntigravityStructuredEvents(connection, snapshot?.events, { replace: initial });
    renderAntigravityStructuredPermissions(connection, pending?.permissions);
    connection.nativeLoading = false; connection.connectionLost = false;
    const status = snapshot?.status || {};
    connection.taskStatus = status.closed ? "stopped" : status.failed ? "failed" : "waiting";
    applyGenericTaskSnapshot({ id: connection.sid, taskId: connection.sid, agentId: "antigravity", status: connection.taskStatus,
      nativeAntigravityStructured: true, nativeStatus: status });
    syncGenericInputState();
  } catch {
    if (rpc !== connection) return;
    connection.nativeLoading = false; connection.connectionLost = true; syncGenericInputState();
  } finally {
    connection.nativeRefreshInFlight = false;
  }
}

async function openAntigravityStructuredTask(task, generationOverride = null) {
  if (!task) return;
  const nativeSessionId = String(task.id || task.taskId || "").replace(/^antigravity:/, "");
  if (!nativeSessionId) return;
  const cwd = task.cwd || ""; const name = task.name || "Google Antigravity";
  rememberLastAgentTask(task.id || `antigravity:${nativeSessionId}`); beginDraftScope({ cwd, name });
  const generation = generationOverride === null ? ++viewGeneration : generationOverride;
  if (rpc) closeChat(!!(rpc.streaming || rpc.connectionLost));
  resetTaskProgress(); resetProjectChanges(); resetComposerSummary(); currentSessionFile = null;
  currentAgentTaskId = `antigravity:${nativeSessionId}`; updateSessionSelection(); _lastMsgDate = null; lastUserText = ""; currentSessionCwd = cwd;
  historyState = null; removeHistoryLoadButton(); autoScrollPinned = true; hideChatEmpty(); setChatTitle(name); setChatAgent("antigravity");
  el.chatSub.dataset.base = cwd; el.chatSub.textContent = cwd; resetLiveUsage(); el.messages.innerHTML = ""; resetSessionUsage(); ensureSessionUsageFooter();
  if (!isDesktop()) { el.viewList.classList.add("hidden"); syncSessionListPolling(); }
  el.viewChat.classList.remove("hidden"); void refreshProjectChanges({ background: true });
  rpc = { sid: `antigravity:${nativeSessionId}`, generic: true, nativeAntigravityStructured: true, nativeSessionId, nativeLoading: true,
    connectionLost: false, stopPending: false, streamReady: true, taskStatus: "waiting", genericOutputNode: null, genericTerminalNotice: null,
    genericInputEchoes: [], antigravityEventIndex: 0, agentId: "antigravity", agentLabel: "Google Antigravity", name, cwd,
    runStartedAt: normalizedTimestampMs(task.startedAt) || Date.now(), runEndedAt: null };
  const connection = rpc; antigravityStructuredPollTimer = null;
  try {
    await refreshAntigravityStructuredSnapshot(connection, { initial: true });
    if (rpc !== connection || generation !== viewGeneration) return;
    antigravityStructuredPollTimer = setInterval(() => void refreshAntigravityStructuredSnapshot(connection), 2000); syncGenericInputState();
  } catch (error) {
    if (rpc === connection && generation === viewGeneration) { toast(tKey("runtime.openChatFailed", { detail: error.message }), true); closeChat(true); showList(); }
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
  updateSessionSelection();
  _lastMsgDate = null;
  lastUserText = "";
  currentSessionCwd = cwd;
  historyState = null;
  removeHistoryLoadButton();
  autoScrollPinned = true;
  hideChatEmpty();
  setChatTitle(name);
  setChatAgent(task.agentId || "agent");
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

function agentOpenFailureAgentId(options = {}) {
  const direct = String(options.agentId || "").trim();
  if (direct) return direct;
  const taskId = String(options.taskId || "");
  return taskId.includes(":") ? taskId.slice(0, taskId.indexOf(":")) : "";
}

function agentOpenFailureText(error, options = {}) {
  const code = String(error?.code || "");
  const message = String(error?.message || "");
  const agentId = agentOpenFailureAgentId(options);
  if (agentId === "claude-code" && (code === "desktop_sign_in_required" || message === "desktop_sign_in_required")) {
    return tKey("agentHub.claudeSignInRequired");
  }
  if (code === "project_folder_unavailable" || message === "Project folder is unavailable") {
    return tKey("agentHub.projectFolderUnavailable");
  }
  return message || tKey("runtime.openChatFailed", { detail: "unknown error" });
}

function guideClaudeCodeSignIn() {
  void openAgentTerminal({ agentId: "claude-code", action: "login" });
}

async function connectAgentTask(options = {}, generation = viewGeneration) {
  const baseAtStart = apiBase;
  // Keep timestamp handling self-contained here because this function is also
  // exercised as an isolated browser slice in the reliability tests.
  const taskTimestampMs = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    if (number >= 1e17) return Math.floor(number / 1e6);
    if (number >= 1e14) return Math.floor(number / 1e3);
    if (number >= 1e11) return number;
    return number * 1000;
  };
  resetGenericReplayNotice();
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
        resumeSessionId: options.resumeSessionId,
        worktree: !!options.worktree,
      }, options.signal ? { signal: options.signal } : {});
    }
    if (result?.kind === "pi") {
      if (String(result.agentId || "") !== "pi") {
        const sid = typeof result.sid === "string" ? result.sid : "";
        if (sid && !result.reused) fetch(baseAtStart + "/api/close", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sid }),
        }).catch(() => {});
        throw new Error("Invalid native agent response");
      }
      await connectRpc(null, generation, result, baseAtStart, options.signal || null);
      return;
    }
    if (result?.kind === "opencode-native" || result?.nativeOpenCode === true) {
      await openOpenCodeNativeTask(result, generation);
      return;
    }
    if (result?.kind === "grok-acp" || result?.nativeGrokAcp === true) {
      await openGrokAcpTask(result, generation);
      return;
    }
    if (result?.kind === "acp" || result?.nativeAcp === true) {
      await openAgentClientProtocolTask(result, generation);
      return;
    }
    if (result?.kind === "claude-structured" || result?.nativeClaudeStructured === true) {
      await openClaudeStructuredTask(result, generation);
      return;
    }
    if (result?.kind === "antigravity-structured" || result?.nativeAntigravityStructured === true) {
      await openAntigravityStructuredTask(result, generation);
      return;
    }
    if (result?.nativeCodex === true || result?.nativeThreadId && result?.agentId === "codex") {
      await openCodexNativeTask(result, generation);
      return;
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
      genericReplayGap: false,
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
      genericInputEchoes: [],
      agentId: String(result.agentId || options.agentId || "agent"),
      agentLabel: agentConnectorLabel(result.agentId || options.agentId),
      name: result.name || options.name || "Agent task",
      cwd: result.cwd || options.cwd || currentSessionCwd || "",
      runStartedAt: taskTimestampMs(result.startedAt) || null,
      runEndedAt: taskTimestampMs(result.endedAt) || null,
    };
    const connection = rpc;
    const ownsTask = () => rpc === connection && generation === viewGeneration && baseAtStart === apiBase;
    currentAgentTaskId = taskId;
    updateAgentTaskCache({ ...result, id: taskId });
    setStreaming(rpc.streaming);
    let esFail = 0;

    const scheduleReconnect = (es) => {
      if (!ownsTask() || rpc.streamEnded || rpc.es !== es) return;
      if (rpc.readyTimer) clearTimeout(rpc.readyTimer);
      rpc.readyTimer = null;
      rpc.streamReady = false;
      try { es?.close(); } catch {}
      if (rpc.es === es) rpc.es = null;
      rpc.connectionLost = true;
      syncGenericInputState();
      const attempt = ++rpc.reconnectAttempt;
      const delay = Math.min(30_000, 800 * (2 ** Math.min(attempt - 1, 5)));
      el.queueNote.dataset.connection = "lost";
      el.queueNote.textContent = rpc.streaming
        ? tKey("runtime.streamRetry", { seconds: Math.ceil(delay / 1000) })
        : tKey("runtime.streamRecovering");
      el.queueNote.classList.remove("hidden");
      if (rpc.reconnectTimer) return;
      rpc.reconnectTimer = setTimeout(() => {
        if (!ownsTask() || rpc.streamEnded) return;
        rpc.reconnectTimer = null;
        openStream(Math.max(-1, Number(rpc.lastEventId) || -1));
      }, delay);
    };

    const openStream = (after, canonicalHistory = false) => {
      if (!ownsTask() || rpc.streamEnded) return;
      const historyFlag = canonicalHistory ? "&canonicalHistory=1" : "";
      const es = new EventSource(baseAtStart + "/api/agent/stream?taskId=" + encodeURIComponent(taskId) + "&after=" + encodeURIComponent(after) + historyFlag);
      rpc.es = es;
      rpc.streamReady = false;
      syncGenericInputState();
      const ownsStream = () => ownsTask() && rpc.es === es;
      if (rpc.readyTimer) clearTimeout(rpc.readyTimer);
      rpc.readyTimer = setTimeout(() => {
        if (ownsStream() && !rpc.streamReady && !rpc.streamEnded) scheduleReconnect(es);
      }, 12_000);
      const markStreamReady = (snapshot = null) => {
        if (!ownsStream() || rpc.streamEnded) return;
        rpc.streamReady = true;
        if (rpc.readyTimer) clearTimeout(rpc.readyTimer);
        rpc.readyTimer = null;
        esFail = 0;
        rpc.connectionLost = false;
        rpc.reconnectAttempt = 0;
        rpc.lastEventAt = Date.now();
        rpc.snapshotEventSeq = snapshot.eventSeq;
        applyGenericTaskSnapshot(snapshot);
        applyGenericApprovals(snapshot.canonical?.pendingApprovals);
        if (genericTaskTerminal(rpc.taskStatus)) rpc.streamEnded = true;
        if (el.queueNote.dataset.connection === "lost") {
          delete el.queueNote.dataset.connection;
          if (!rpc.streaming) el.queueNote.classList.add("hidden");
          else el.queueNote.textContent = tKey("runtime.streamRestored");
        }
      };
      es.onopen = () => {
        if (!ownsStream()) { try { es.close(); } catch {} }
        // Transport-open alone does not confirm the task or writable state.
      };
      es.addEventListener("connected", (event) => {
        if (!ownsStream()) { try { es.close(); } catch {} return; }
        let snapshot = null;
        try { snapshot = JSON.parse(event.data); } catch {}
        if (!snapshot || (snapshot.taskId ?? snapshot.id) !== taskId || snapshot.id !== undefined && snapshot.id !== taskId
          || !Number.isSafeInteger(snapshot.eventSeq) || snapshot.eventSeq < 0
          || Object.hasOwn(snapshot, "replayFloor") && (!Number.isSafeInteger(snapshot.replayFloor) || snapshot.replayFloor < 1 || snapshot.replayFloor > snapshot.eventSeq + 1)
          || Object.hasOwn(snapshot, "replayTruncated") && typeof snapshot.replayTruncated !== "boolean"
          || Object.hasOwn(snapshot, "replayGap") && typeof snapshot.replayGap !== "boolean"
          || Object.hasOwn(snapshot, "replayAfter") && (!Number.isSafeInteger(snapshot.replayAfter) || snapshot.replayAfter < -1)
          || !["starting", "running", "waiting", "reconnecting", "completed", "failed", "stopped", "orphaned", "detached"].includes(snapshot.status)) {
          scheduleReconnect(es); return;
        }
        if (snapshot.eventSeq < rpc.lastEventId) rpc.lastEventId = -1;
        markStreamReady(snapshot);
      });
      es.onmessage = (event) => {
        if (!ownsStream()) { try { es.close(); } catch {} return; }
        if (!rpc.streamReady) return;
        const eventId = Number(event.lastEventId);
        if (Number.isFinite(eventId)) rpc.lastEventId = Math.max(rpc.lastEventId, eventId);
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (!data || typeof data !== "object" || data.taskId !== undefined && data.taskId !== taskId) return;
        // Connected is the current lifecycle snapshot. Historical output is
        // still replayed, but old task_started/status/exit must not revive input.
        if (["task_started", "status", "task_exit"].includes(data.type) && eventId <= rpc.snapshotEventSeq) return;
        handleAgentTaskEvent(data, taskId);
        if (data.type === "task_exit" && genericTaskTerminal(rpc.taskStatus)) { try { es.close(); } catch {} }
      };
      es.onerror = () => {
        if (!ownsStream()) { try { es.close(); } catch {} return; }
        // EOF on a completed record is expected. EventSource otherwise retries
        // automatically forever even though no more live output can arrive.
        if (rpc.streamEnded) { try { es.close(); } catch {} return; }
        rpc.streamReady = false; rpc.connectionLost = true; syncGenericInputState();
        esFail++;
        if (esFail >= 3 && baseAtStart) showRemoteAuthorizationState(baseAtStart);
        if (esFail >= 3) scheduleReconnect(es);
      };
    };
    rpc.lastEventId = Number.isSafeInteger(Number(result.eventSeq)) ? Number(result.eventSeq) : -1;
    const canonicalHistoryLoaded = await loadGenericCanonicalHistory(result, taskId, connection);
    openStream(rpc.lastEventId, canonicalHistoryLoaded);
  } catch (error) {
    if (options.signal?.aborted || generation !== viewGeneration || baseAtStart !== apiBase) return;
    const needsClaudeSignIn = agentOpenFailureAgentId(options) === "claude-code" && String(error?.code || "") === "desktop_sign_in_required";
    if (needsClaudeSignIn) {
      guideClaudeCodeSignIn();
    }
    const failedAgent = agentOpenFailureAgentId(options);
    const offerSignIn = !needsClaudeSignIn && failedAgent && agentSignInError(error);
    toast(agentOpenFailureText(error, options), true, offerSignIn
      ? { label: tKey("agentTerminal.signInAction"), run: () => void openAgentTerminal({ agentId: failedAgent, action: "login" }) } : null);
    if (!needsClaudeSignIn) showList();
  }
}

function closeChat(silent) {
  if (WORKSPACE_PANE) silent = true;
  const awaitingNative = rpc && !rpc.generic && nativeDialogs.count(apiBase, rpc.sid) > 0;
  resetNativeDialogs();
  if (openCodeNativePollTimer) { clearInterval(openCodeNativePollTimer); openCodeNativePollTimer = null; }
  if (codexNativePollTimer) { clearInterval(codexNativePollTimer); codexNativePollTimer = null; }
  if (grokAcpPollTimer) { clearInterval(grokAcpPollTimer); grokAcpPollTimer = null; }
  if (acpPollTimer) { clearInterval(acpPollTimer); acpPollTimer = null; }
  if (claudeStructuredPollTimer) { clearInterval(claudeStructuredPollTimer); claudeStructuredPollTimer = null; }
  if (antigravityStructuredPollTimer) { clearInterval(antigravityStructuredPollTimer); antigravityStructuredPollTimer = null; }
  if (rpc) {
    rpc.nativeHistoryRequest?.abort();
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
  renderCodexNativeRunState(null);
  delete el.queueNote.dataset.connection;
  pendingAssistant = null;
  liveToolCards = new Map();
  liveActivity = null;
  activeActivityRun = null;
  resetTaskProgress();
  historyState = null;
  removeHistoryLoadButton();
  removeCodexNativeHistoryButton();
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
  setContextPopover(false);
  contextStatsRequestSequence += 1;
  nativeContextRequestSequence += 1;
  if (nativeContextRequest?.controller) nativeContextRequest.controller.abort();
  nativeContextRequest = null;
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

// OpenCode reports per-message token usage and the model that produced it.
// Feeding that into the existing dashboard keeps one context display for every
// agent instead of a second, parallel one.
// ACP returns the turn's token usage on the prompt reply rather than in the
// event stream, so it is captured where the reply lands.
function applyAcpContextStats(result, connection = rpc) {
  if (!connection?.nativeAcp || rpc !== connection) return;
  const usage = result?.result?.usage || result?.usage || null;
  if (!usage) return;
  const input = finiteNonNegative(usage.inputTokens) ?? 0;
  const output = finiteNonNegative(usage.outputTokens) ?? 0;
  const reasoning = finiteNonNegative(usage.thoughtTokens) ?? 0;
  const cacheRead = finiteNonNegative(usage.cachedReadTokens) ?? 0;
  const used = finiteNonNegative(usage.totalTokens) ?? (input + cacheRead + output + reasoning);
  const capacity = positiveFinite(composerModelContextWindow);
  contextStats = {
    tokens: { input, output, reasoning, cacheRead, cacheWrite: 0 },
    contextUsage: {
      tokens: used,
      contextWindow: capacity,
      percent: capacity ? Math.min(100, (used / capacity) * 100) : null,
    },
    contextCapacity: capacity,
  };
  contextStatsState = "ready";
  renderContextDashboard();
}

function applyOpenCodeContextStats(snapshot, connection = rpc) {
  if (!connection?.nativeOpenCode || rpc !== connection) return;
  contextStats = openCodeContext.contextStatsFromSnapshot(snapshot, {
    modelCatalog: connection.openCodeModels || [], selectedModel: connection.openCodeModel,
  });
  contextStatsState = contextStats?.contextUsage?.percent == null ? "awaiting" : "ready";
  renderContextDashboard();
}

function nativeContextRecord(response) {
  if (response && typeof response === "object" && response.data
    && typeof response.data === "object" && !Array.isArray(response.data)) return response.data;
  return response && typeof response === "object" && !Array.isArray(response) ? response : {};
}

function nativeContextValue(...values) {
  return values.find(value => value !== undefined && value !== null) ?? null;
}

// Claude/Codex deliberately have a small, adapter-owned stats contract rather
// than Pi's get_session_stats envelope. Normalize both without deriving a
// percentage: contextPercent is authoritative and must remain unknown when a
// provider does not report a context window or current prompt size.
function normalizeNativeContextStats(response) {
  const data = nativeContextRecord(response);
  const rawContext = data.contextUsage && typeof data.contextUsage === "object" ? data.contextUsage : {};
  const rawUsage = data.usage && typeof data.usage === "object" ? data.usage
    : data.tokens && typeof data.tokens === "object" ? data.tokens : {};
  const usage = normalizeWireUsage({
    input: nativeContextValue(rawUsage.input, rawUsage.inputTokens, rawUsage.promptTokens),
    output: nativeContextValue(rawUsage.output, rawUsage.outputTokens, rawUsage.completionTokens),
    cacheRead: nativeContextValue(rawUsage.cacheRead, rawUsage.cacheReadTokens, rawUsage.cachedReadTokens, rawUsage.cachedInputTokens),
    cacheWrite: nativeContextValue(rawUsage.cacheWrite, rawUsage.cacheWriteTokens, rawUsage.cachedWriteTokens, rawUsage.cacheWriteInputTokens),
    totalTokens: nativeContextValue(rawUsage.totalTokens, rawUsage.total),
    cost: rawUsage.cost ?? data.cost,
  }) || {};
  const reasoning = finiteNonNegative(nativeContextValue(
    rawUsage.reasoningOutputTokens, rawUsage.reasoningTokens, rawUsage.reasoning,
  ));
  const contextTokens = finiteNonNegative(nativeContextValue(
    data.contextTokens, data.context_tokens, rawContext.tokens, rawContext.contextTokens,
  ));
  const contextWindow = positiveFinite(nativeContextValue(
    data.contextWindow, data.context_window, rawContext.contextWindow, rawContext.window,
  ));
  const contextPercent = finiteNonNegative(nativeContextValue(
    data.contextPercent, data.context_percent, rawContext.percent,
  ));
  const model = data.model ?? data.currentModel ?? null;
  const hasDtoFields = ["model", "contextWindow", "contextTokens", "contextPercent", "usage"]
    .some(key => Object.prototype.hasOwnProperty.call(data, key));
  const available = hasDtoFields || contextTokens !== null || contextWindow !== null
    || contextPercent !== null || Object.keys(usage).length > 0 || model !== null;
  return {
    available,
    model,
    source: data.source === "last_observed" ? "last_observed"
      : data.source === "persisted_live_observation" ? "persisted_live_observation"
        : data.source === "live" ? "live" : "unknown",
    observedAt: typeof data.observedAt === "string" && Number.isFinite(Date.parse(data.observedAt)) ? data.observedAt : null,
    stale: data.stale === true,
    tokens: {
      input: finiteNonNegative(usage.input),
      output: finiteNonNegative(usage.output),
      reasoning,
      cacheRead: finiteNonNegative(usage.cacheRead),
      cacheWrite: finiteNonNegative(usage.cacheWrite),
      total: finiteNonNegative(usage.totalTokens ?? usage.total ?? usage.tokens),
    },
    cost: usage.cost ?? null,
    contextUsage: { tokens: contextTokens, contextWindow, percent: contextPercent },
    contextCapacity: contextWindow,
  };
}

function nativeContextRequestIsCurrent(request) {
  return !!request && rpc === request.connection && rpc?.sid === request.sid
    && request.generation === viewGeneration && request.base === apiBase
    && request.sequence === nativeContextRequestSequence;
}

function nativeContextPath(connection) {
  if (connection?.nativeCodex || connection?.nativeCodexMutation) {
    return `/api/codex/context?threadId=${encodeURIComponent(connection.nativeThreadId)}`;
  }
  if (connection?.nativeClaudeStructured) {
    return `/api/claude/structured/context?sessionId=${encodeURIComponent(connection.nativeSessionId)}`;
  }
  return null;
}

function applyNativeContextStats(response, connection = rpc) {
  if (!connection || rpc !== connection) return null;
  const normalized = normalizeNativeContextStats(response);
  contextStats = normalized;
  contextStatsState = normalized.available ? "ready" : "unavailable";
  // A context response is also the first reliable model hint for resumed
  // Claude/Codex sessions. Keep the model chip in sync without replacing a
  // deliberately selected next-prompt Codex model with an older observation.
  const isCodex = connection.nativeCodex || connection.nativeCodexMutation;
  const hasExplicitModel = isCodex
    ? connection.codexModelSelected === true
    : connection.claudeModelSelected === true;
  if (normalized.model !== null && !hasExplicitModel) {
    // A context response only names the model. The catalog entry for the same
    // model carries its display name and reasoning levels, so use that; the
    // bare name used to replace it and hide the level beside the model.
    const observed = isCodex ? normalizeCodexModel(normalized.model) : null;
    const model = isCodex
      ? observed && (Array.isArray(connection.codexModels) && connection.codexModels.find(row => row?.id === observed.id) || observed)
      : claudeModelFromCatalog(connection.claudeModels, normalized.model);
    if (model) {
      if (isCodex) connection.codexModel = model;
      else connection.claudeModel = model;
      composerModelContextWindow = positiveFinite(model.contextWindow);
      updateComposerSummary(model.name || model.id, undefined);
    }
  }
  renderContextDashboard();
  return normalized;
}

/** Fetch adapter-owned current-context stats, fenced to the visible session. */
function syncNativeContext(connection = rpc) {
  if (!connection || rpc !== connection) return Promise.resolve(null);
  const path = nativeContextPath(connection);
  if (!path) return Promise.resolve(null);
  const identity = { connection, sid: connection.sid, generation: viewGeneration, base: apiBase };
  const active = nativeContextRequest;
  if (active && active.connection === connection && active.sid === connection.sid
    && active.generation === identity.generation && active.base === identity.base) {
    active.needsRefresh = true;
    return active.promise;
  }
  const request = {
    ...identity,
    sequence: ++nativeContextRequestSequence,
    controller: new AbortController(),
    needsRefresh: false,
    promise: null,
  };
  const promise = api(path, { signal: request.controller.signal })
    .then((response) => {
      if (!nativeContextRequestIsCurrent(request) || request.needsRefresh) return null;
      return applyNativeContextStats(response, connection);
    })
    .catch((error) => {
      if (error?.name === "AbortError" || !nativeContextRequestIsCurrent(request)) return null;
      contextStatsState = "unavailable";
      renderContextDashboard();
      return null;
    });
  request.promise = promise;
  nativeContextRequest = request;
  promise.finally(() => {
    if (nativeContextRequest !== request) return;
    nativeContextRequest = null;
    if (!request.needsRefresh || !nativeContextRequestIsCurrent(request)) return;
    request.needsRefresh = false;
    queueMicrotask(() => { if (nativeContextRequestIsCurrent(request)) void syncNativeContext(connection); });
  }).catch(() => {});
  return promise;
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
  const modelCapacity = contextStats?.reason === "model_mismatch" ? null : positiveFinite(composerModelContextWindow);
  const capacity = contextStatsState === "unavailable"
    ? modelCapacity
      ?? positiveFinite(contextStats?.contextCapacity)
    : positiveFinite(contextUsage?.contextWindow)
      ?? positiveFinite(contextStats?.contextCapacity)
      ?? modelCapacity;
  // Pi's contextUsage.percent is authoritative. Do not derive this from the
  // cumulative token totals: those totals survive compaction and count work
  // which is no longer in the current prompt context.
  const percent = finiteNonNegative(contextUsage?.percent);
  const lastObserved = statsForValues?.source === "last_observed" && statsForValues?.stale === true;
  const visiblePercent = percent === null ? tKey("contextDashboard.unknown") : `${lastObserved ? "~" : ""}${formatPercent(percent)}`;
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
  setValue(el.contextPercent, percent === null ? "—" : visiblePercent);
  setValue(el.contextInlinePercent, visiblePercent);
  if (el.contextInfo) {
    el.contextInfo.setAttribute("aria-label", `${tKey("contextDashboard.context")}: ${visiblePercent}`);
    el.contextInfo.title = `${tKey("contextDashboard.context")}: ${visiblePercent} · ${tKey("contextDashboard.details")}`;
  }
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
    el.contextProgress.setAttribute("aria-valuetext", visiblePercent);
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
    used: formatTokenCount(used), capacity: formatTokenCount(capacity), percent: visiblePercent,
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
      : lastObserved && statsForValues?.observedAt ? tKey("contextDashboard.lastReported", {
        time: new Date(statsForValues.observedAt).toLocaleString(),
      })
      : contextStats?.reason === "model_mismatch" ? tKey("contextDashboard.modelChanged")
      : used !== null && capacity === null ? tKey("contextDashboard.capacityUnknown")
      : (!contextStats || contextStatsState === "awaiting" || used === null || percent === null
        ? tKey("contextDashboard.notReported") : "");
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

function codexImagePreviewSrc(preview) {
  const value = preview && typeof preview === "object" ? String(preview.url || "") : "";
  if (!/^\/api\/codex\/image\?token=[A-Za-z0-9_%=-]{24,160}$/.test(value)) return "";
  return `${apiBase}${value}`;
}

function openCodexImageLightbox(src, alt, trigger) {
  if (!src || !el.imageLightbox || !el.imageLightboxImg) return;
  imageLightboxTrigger = trigger;
  el.imageLightboxImg.src = src;
  el.imageLightboxImg.alt = alt;
  if (el.imageLightboxCaption) el.imageLightboxCaption.textContent = alt;
  el.imageLightbox.classList.remove("hidden");
  document.body.classList.add("image-lightbox-open");
  el.imageLightboxClose?.focus({ preventScroll: true });
}

function makeCodexImageViews(tools) {
  const section = document.createElement("section");
  section.className = "native-image-views";
  const heading = document.createElement("div");
  heading.className = "native-image-views-heading";
  const count = Math.max(1, tools.length);
  heading.textContent = count === 1
    ? (window.stepsembleI18n?.t("Viewed an image") || "Viewed an image")
    : (window.stepsembleI18n?.t("Viewed {count} images", { count }) || `Viewed ${count} images`);
  section.appendChild(heading);
  const gallery = document.createElement("div");
  gallery.className = "native-image-gallery";
  for (const tool of tools) {
    const preview = tool.preview;
    const src = codexImagePreviewSrc(preview);
    const rawPath = String(tool.args?.path || "");
    const fallbackName = rawPath.split(/[\\/]/).filter(Boolean).at(-1) || "image";
    const label = String(preview?.name || fallbackName).slice(0, 255);
    const card = document.createElement(src ? "button" : "div");
    if (src) card.type = "button";
    card.className = "native-image-card" + (src ? "" : " unavailable");
    if (src) {
      const img = document.createElement("img");
      img.src = src;
      img.alt = label;
      img.loading = "lazy";
      img.decoding = "async";
      img.addEventListener("error", () => card.classList.add("unavailable"), { once: true });
      card.appendChild(img);
      card.addEventListener("click", () => openCodexImageLightbox(src, label, card));
      card.setAttribute("aria-label", `${window.stepsembleI18n?.t("Viewed an image") || "Viewed an image"}: ${label}`);
    }
    const caption = document.createElement("span");
    caption.textContent = label;
    card.appendChild(caption);
    gallery.appendChild(card);
  }
  section.appendChild(gallery);
  return section;
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
  toggle.dataset.i18nIgnore = "";
  toggle.textContent = tKey("work.item.thinking");
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
  const target = toolTarget(args);
  const short = toolTargetShort(args);
  // Codex-style action lines: "Ran npm test", "Edited app.js", "Read log".
  const state = running ? "active" : "done";
  const category = window.stepsembleSessionUtils.workCategory(name, args);
  const label = String(name || "tool");
  const file = short || target || label;
  const title = category === "run" ? tKey(`work.item.run.${state}`, { target: target || label })
    : category === "read" ? tKey(`work.item.read.${state}`, { target: file })
    : category === "edit" ? tKey(`work.item.edit.${state}`, { target: workEditTarget(args) || file })
    : category === "search" ? tKey(`work.item.search.${state}`, { target: target || label })
    : category === "web" ? tKey(`work.item.web.${state}`, { target: target || label })
    : category === "image" ? tKey(`work.item.image.${state}`, { target: file })
    : category === "agent" ? tKey(`work.item.agent.${state}`, { target: target || label })
    : ["plan", "context", "wait"].includes(category) ? tKey(`work.item.${category}.${state}`)
    : tKey(`work.item.tool.${state}`, { name: label, target: target ? ` ${target}` : "" });
  return title.replace(/\s+/g, " ").trim();
}
// A multi-file change names every file; one file shows its base name.
function workEditTarget(args) {
  const changes = window.stepsembleSessionUtils.toolEditChanges("edit", args);
  if (changes.length > 1) return changes.map(change => change.path.split(/[\\/]/).filter(Boolean).pop() || change.path).join(", ");
  const path = changes[0]?.path || "";
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}
function toolEditTotals(name, args) {
  const changes = window.stepsembleSessionUtils.toolEditChanges(name, args);
  if (!changes.length) return null;
  return changes.reduce((sum, change) => ({ added: sum.added + change.added, removed: sum.removed + change.removed }), { added: 0, removed: 0 });
}
function renderToolStat(card) {
  const stat = card?.querySelector(".tool-stat");
  if (!stat) return;
  const meta = card.__tool || {};
  const totals = card.classList.contains("err") ? null : toolEditTotals(meta.name, meta.args);
  stat.replaceChildren();
  stat.hidden = !totals || (!totals.added && !totals.removed);
  if (stat.hidden) return;
  const added = document.createElement("span");
  added.className = "wl-add";
  added.textContent = `+${totals.added}`;
  const removed = document.createElement("span");
  removed.className = "wl-del";
  removed.textContent = `-${totals.removed}`;
  stat.append(added, removed);
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
  title.dataset.i18nIgnore = "";
  title.textContent = toolTitle(name, args, running);
  title.title = toolTitle(name, args, false);
  const stat = document.createElement("span");
  stat.className = "tool-stat";
  stat.dataset.i18nIgnore = "";
  info.append(title, stat);
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
  renderToolStat(details);
  return details;
}
function ensureActivityGroup({ bubble = null, running = true } = {}) {
  let target = bubble;
  if (!target) target = pendingAssistant?.bubble || liveActivity?.details?.parentElement || null;
  if (!target) {
    const assistants = el.messages.querySelectorAll(".msg.assistant .bubble");
    target = assistants[assistants.length - 1] || null;
  }
  if (!target) {
    ensurePendingAssistant();
    target = pendingAssistant?.bubble || null;
  }
  if (!target) return null;
  // Work is shown in the order it happened. The current group keeps growing
  // only while nothing has been written after it; once prose follows it, the
  // next tool call starts a new group below that prose.
  for (const candidate of [pendingAssistant?.activity, liveActivity]) {
    if (!candidate?.details || candidate.details.parentElement !== target || lastWorkChild(target) !== candidate.details) continue;
    liveActivity = candidate;
    if (pendingAssistant?.bubble === target) pendingAssistant.activity = candidate;
    registerRunActivity(candidate);
    updateActivityGroup(candidate, { running: running || candidate.running });
    return candidate;
  }
  const activity = makeActivityGroup({ running });
  const pendingText = pendingAssistant?.bubble === target ? pendingAssistant.textEl : null;
  // Thinking that starts before any prose stays above the streaming text.
  if (pendingText?.parentNode === target && !pendingTextPresent(pendingText)) target.insertBefore(activity.details, pendingText);
  else target.appendChild(activity.details);
  if (pendingAssistant?.bubble === target) pendingAssistant.activity = activity;
  liveActivity = activity;
  registerRunActivity(activity);
  return activity;
}
function pendingTextPresent(node) {
  if (!node) return false;
  return !!String(node.textContent || "").trim() || (pendingAssistant?.textEl === node && !!String(pendingAssistant.textBuffer || "").trim());
}
// The last child that carries content: work-log chrome, the streaming
// placeholder and empty text nodes do not count.
function lastWorkChild(bubble) {
  for (let node = bubble?.lastChild; node; node = node.previousSibling) {
    if (node.nodeType === Node.TEXT_NODE) { if (pendingTextPresent(node)) return node; continue; }
    if (node.nodeType !== Node.ELEMENT_NODE || workOwned(node) || node.classList.contains("thinking-shimmer")) continue;
    return node;
  }
  return null;
}
function firstWorkChild(bubble) {
  for (let node = bubble?.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === Node.TEXT_NODE) { if (pendingTextPresent(node)) return node; continue; }
    if (node.nodeType !== Node.ELEMENT_NODE || workOwned(node) || node.classList.contains("thinking-shimmer")) continue;
    return node;
  }
  return null;
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
  renderToolStat(card);
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
  scheduleWorkLog(workTopLevel(card) || "tail");
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
    const { wrap, bubble } = makeMsgShell("user", "你", container);
    stampMessageTime(wrap, m.ts || m.timestamp);
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
    stampMessageTime(wrap, m.ts || m.timestamp);
    const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
    // Pi stores thinking, then prose, then tool calls: keep that order so the
    // work log reads as it happened.
    let activity = null;
    if (m.thinking) {
      activity = makeActivityGroup({ running: false });
      bubble.appendChild(activity.details);
      activity.body.appendChild(makeThinking(m.thinking));
      updateActivityGroup(activity, { running: false });
    }
    if (m.text) bubble.appendChild(renderMarkdown(m.text));
    if (calls.length) {
      if (!activity || m.text) {
        activity = makeActivityGroup({ running: false, count: calls.length });
        bubble.appendChild(activity.details);
      }
      for (const tc of calls) {
        const card = makeToolCard(tc.name, tc.args, null);
        if (tc.id) card.dataset.toolCallId = tc.id;
        activity.body.appendChild(card);
        activity.latest = toolTitle(tc.name, tc.args, false);
      }
      updateActivityGroup(activity, { running: false, count: calls.length, latest: activity.latest });
    }
    if (isFailureMessage(m)) {
      if (activity) updateActivityGroup(activity, { running: false, hasError: true });
      appendRunError(bubble, m);
    }
    wrap.appendChild(msgActionsRow("assistant", () => m.text || m.errorMessage || ""));
    if (m.usage) attachMessageUsage(wrap, m.usage, activity);
  } else if (m.role === "toolResult") {
    attachToolResult(m.toolName, m.isError, m.text, container, m.toolCallId);
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
  // Work-log chrome is rebuilt for the merged turn; never carry it along.
  for (const node of [...sourceBubble.childNodes]) if (workOwned(node)) node.remove();
  // Messages join in order. Work at the end of one message and at the start
  // of the next is one uninterrupted step, so those two groups become one.
  const tail = lastWorkChild(targetBubble);
  const head = firstWorkChild(sourceBubble);
  const tailActivity = tail?.classList?.contains("activity-group") ? tail.__activity : null;
  const headActivity = head?.classList?.contains("activity-group") ? head.__activity : null;
  if (tailActivity && headActivity) {
    for (const child of [...headActivity.body.children]) tailActivity.body.appendChild(child);
    updateActivityGroup(tailActivity, {
      running: tailActivity.running || headActivity.running,
      latest: headActivity.latest || tailActivity.latest,
      count: activityCards(tailActivity).length,
      hasError: tailActivity.hasError || headActivity.hasError,
    });
    if (head.open) tail.open = true;
    head.remove();
    if (activeActivityRun?.activities?.has(headActivity)) activeActivityRun.activities.add(tailActivity);
    if (liveActivity === headActivity) liveActivity = tailActivity;
    if (pendingAssistant?.activity === headActivity) pendingAssistant.activity = tailActivity;
  }
  for (const child of [...sourceBubble.childNodes]) targetBubble.appendChild(child);

  // One copy/retry row serves the merged turn. Keep the newest message's row
  // so Copy returns the latest reply, and keep it after the usage rows.
  const sourceActions = [...source.children].filter(child => child.classList.contains("msg-actions"));
  if (sourceActions.length) for (const row of [...target.children]) if (row.classList.contains("msg-actions")) row.remove();
  for (const child of [...source.children]) {
    if (child.classList.contains("message-usage")) {
      target.appendChild(child);
      bindMessageUsage(child, lastWorkActivity(targetBubble));
    }
  }
  for (const row of sourceActions) target.appendChild(row);
  const sourceTime = Number(source.dataset.ts) || 0;
  if (sourceTime > (Number(target.dataset.ts) || 0)) target.dataset.ts = String(sourceTime);
  if (pendingAssistant?.wrap === source) {
    pendingAssistant.wrap = target;
    pendingAssistant.bubble = targetBubble;
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
function lastWorkActivity(bubble) {
  const groups = [...(bubble?.children || [])].filter(child => child.classList.contains("activity-group"));
  return groups[groups.length - 1]?.__activity || null;
}
function attachToolResult(toolName, isError, text, container = el.messages, toolCallId = null) {
  // Parallel calls finish in their own order; match a result to its call
  // when the history names it.
  if (toolCallId) {
    const matched = [...container.querySelectorAll(".tool-card")].reverse().find(card => card.dataset.toolCallId === toolCallId);
    if (matched) {
      setToolCardState(matched, { running: false, isError: !!isError, text });
      return;
    }
  }
  const cards = container.querySelectorAll(".tool-card");
  for (let i = cards.length - 1; i >= 0; i--) {
    const body = cards[i].querySelector(".tool-output");
    if (body && body.textContent === "（執行中…）") {
      setToolCardState(cards[i], { running: false, isError: !!isError, text });
      return;
    }
  }
}

// ===========================================================================
// Work log: Codex-style turns
// ===========================================================================
// Every agent renderer appends its own message shells in the order things
// happened. This layer only annotates that DOM and never moves a renderer's
// node, so streaming text, live tool cards and keyed Codex rows keep their
// references. Per turn it adds a header ("Working for 3m 12s", "Worked for
// 19m 44s"), one row per uninterrupted run of work ("Edited files, read
// files, ran commands") and a card of edited files. A finished turn folds
// down to its final answer until its header is opened.

const WORK_BLOCK_SELECTOR = ".activity-group, .tool-card, .thinking-wrap, .native-image-views";
const WORK_NOTICE_SELECTOR = ".run-error, .agent-approval-card, .agent-terminal-status";
const WORK_SUMMARY_ORDER = Object.freeze(["edit", "read", "search", "web", "run", "image", "agent", "tool", "plan", "context", "wait"]);
const WORK_ICONS = Object.freeze({
  edit: "#i-pencil", read: "#i-book", search: "#i-search", web: "#i-globe", run: "#i-terminal",
  image: "#i-image", agent: "#i-cpu", tool: "#i-wrench", plan: "#i-list", context: "#i-compress",
  wait: "#i-clock", think: "#i-sparkle",
});
const WORK_FILES_PREVIEW = 3;
const workLogState = { turns: new Map(), segments: new Map(), ids: new WeakMap(), sequence: 0, generation: -1,
  frame: null, scope: null, observer: null };

function workOwned(node) { return node?.nodeType === Node.ELEMENT_NODE && node.classList.contains("wl-own"); }
function workNodeId(node) {
  let id = workLogState.ids.get(node);
  if (!id) { id = "n" + (++workLogState.sequence); workLogState.ids.set(node, id); }
  return id;
}
function workTopLevel(node) {
  let current = node;
  while (current?.parentNode && current.parentNode !== el.messages) current = current.parentNode;
  return current?.parentNode === el.messages ? current : null;
}
function stampMessageTime(wrap, value) {
  if (!wrap || value === undefined || value === null || value === "") return;
  const text = String(value).trim();
  const ms = /^\d+(?:\.\d+)?$/.test(text) ? normalizedTimestampMs(Number(text)) : Date.parse(text);
  if (Number.isFinite(ms) && ms > 0) wrap.dataset.ts = String(Math.floor(ms));
}
// A finished live run knows its real end; history falls back to timestamps.
function stampWorkTurnEnd() {
  const endedAt = Number(rpc?.runEndedAt) || Date.now();
  const user = [...(el.messages?.children || [])].filter(node => node.classList.contains("msg") && node.classList.contains("user")).pop();
  if (!user) return;
  const sentAt = Number(user.dataset.ts) || 0;
  if (sentAt && sentAt > endedAt) return;
  if (!sentAt && !user.dataset.wlStart && Number(rpc?.runStartedAt)) user.dataset.wlStart = String(rpc.runStartedAt);
  user.dataset.wlEnd = String(endedAt);
}

function workLogRunState() {
  const connection = rpc;
  if (!connection) return { running: false, startedAt: null };
  let running = !!connection.streaming;
  if (connection.nativeCodex) {
    const state = connection.nativeTranscriptState;
    running = running || connection.taskStatus === "running" || state?.thread?.status?.type === "active"
      || state?.observation?.working === true;
  } else if (connection.generic && !connection.nativeHistoryReadonly) {
    running = running || connection.taskStatus === "running";
  }
  return { running, startedAt: Number(connection.runStartedAt) || null };
}
function workDurationText(ms) {
  const parts = window.stepsembleSessionUtils.workDurationParts(ms);
  return tKey("work.duration." + parts.form, parts);
}
function workHeadText(running, duration) {
  if (running) return duration === null ? tKey("work.working") : tKey("work.workingFor", { time: workDurationText(duration) });
  return duration === null ? tKey("work.worked") : tKey("work.workedFor", { time: workDurationText(duration) });
}
function workTurnDuration(turn) {
  const user = turn.user;
  const start = Number(user?.dataset.wlStart) || Number(user?.dataset.ts) || 0;
  let end = Number(user?.dataset.wlEnd) || 0;
  if (!end) for (const node of turn.nodes) end = Math.max(end, Number(node.dataset?.ts) || 0);
  return start && end && end >= start ? end - start : null;
}

function workTurns() {
  const turns = [];
  let turn = null;
  for (const node of el.messages?.children || []) {
    const message = node.classList.contains("msg");
    if (message && node.classList.contains("user")) { turn = { user: node, nodes: [] }; turns.push(turn); continue; }
    if (!(message && node.classList.contains("assistant")) && !node.classList.contains("context-divider")) continue;
    if (!turn) { turn = { user: null, nodes: [] }; turns.push(turn); }
    turn.nodes.push(node);
  }
  return turns;
}
function workTurnKey(turn, index, seen) {
  const user = turn.user;
  if (user?.dataset.ts) {
    const base = "ts:" + user.dataset.ts;
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return base + "#" + count;
  }
  if (user) {
    const base = "u:" + String(directMessageBubble(user)?.textContent || "").trim().slice(0, 160);
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return base + "#" + count;
  }
  return turn.nodes[0] ? "n:" + workNodeId(turn.nodes[0]) : "i:" + index;
}
function workBlockKind(node) {
  if (node.nodeType === Node.TEXT_NODE) return String(node.textContent || "").trim() ? "text" : null;
  if (node.nodeType !== Node.ELEMENT_NODE || workOwned(node)) return null;
  if (node.classList.contains("thinking-shimmer")) return "pulse";
  if (node.matches(WORK_BLOCK_SELECTOR)) {
    return node.matches(".activity-group") && !node.querySelector(".tool-card, .thinking-wrap, .native-image-views") ? "empty" : "work";
  }
  if (node.matches(WORK_NOTICE_SELECTOR)) return "notice";
  if (!String(node.textContent || "").trim() && !node.querySelector("img, svg, canvas, video")) return null;
  return "text";
}
function workTurnBlocks(turn) {
  const blocks = [];
  for (const node of turn.nodes) {
    if (node.classList.contains("context-divider")) { blocks.push({ node, kind: "divider", shell: null }); continue; }
    const bubble = directMessageBubble(node);
    if (!bubble) continue;
    for (const child of [...bubble.childNodes]) {
      const kind = workBlockKind(child);
      if (kind) blocks.push({ node: child, kind, shell: node });
    }
  }
  return blocks;
}
function workSegments(blocks) {
  const segments = [];
  let current = null;
  for (const block of blocks) {
    if (block.kind === "empty") continue;
    if (block.kind !== "work") { current = null; continue; }
    if (!current) { current = { blocks: [] }; segments.push(current); }
    current.blocks.push(block);
  }
  return segments;
}
function workSegmentKey(segment) {
  const first = segment.blocks[0].node;
  if (first.dataset?.workKey) return "k:" + first.dataset.workKey;
  const card = first.matches(".tool-card") ? first : first.querySelector(".tool-card");
  const id = card?.dataset.toolCallId || card?.dataset.nativeToolId;
  return id ? "t:" + id : "n:" + workNodeId(first);
}
function workSegmentItems(segment) {
  const cards = [];
  let thinking = 0, images = 0;
  for (const { node } of segment.blocks) {
    if (node.matches(".tool-card")) cards.push(node);
    else cards.push(...node.querySelectorAll(".tool-card"));
    thinking += node.matches(".thinking-wrap") ? 1 : node.querySelectorAll(".thinking-wrap").length;
    images += node.matches(".native-image-views") ? node.querySelectorAll(".native-image-card").length
      : node.querySelectorAll(".native-image-views .native-image-card").length;
  }
  return { cards, thinking, images };
}
function workSegmentSummary(items) {
  const counts = new Map();
  for (const card of items.cards) {
    const category = window.stepsembleSessionUtils.workCategory(card.__tool?.name, card.__tool?.args);
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  if (items.images) counts.set("image", (counts.get("image") || 0) + items.images);
  const present = WORK_SUMMARY_ORDER.filter(category => counts.get(category));
  if (!present.length) {
    return { text: tKey(items.thinking ? "work.thought" : "work.worked"), icon: items.thinking ? WORK_ICONS.think : WORK_ICONS.tool };
  }
  const text = present.map(category => tKey("work.part." + category + "." + (counts.get(category) === 1 ? "one" : "many"),
    { count: counts.get(category) })).join(tKey("work.partJoin"));
  const locale = window.stepsembleI18n?.getLocale?.() || "en";
  return { text: text.charAt(0).toLocaleUpperCase(locale) + text.slice(1), icon: WORK_ICONS[present[0]] || WORK_ICONS.tool };
}
function setWorkIcon(box, href) {
  if (!box || box.dataset.icon === href) return;
  box.dataset.icon = href;
  box.innerHTML = '<svg class="icon"><use href="' + href + '"></use></svg>';
}
function workChevron(icon = "#i-chevron-right") {
  const chevron = document.createElement("span");
  chevron.className = "wl-chev";
  chevron.setAttribute("aria-hidden", "true");
  chevron.innerHTML = '<svg class="icon"><use href="' + icon + '"></use></svg>';
  return chevron;
}
// Keep the control the user touched in place while content above it opens.
function layoutWorkLogAround(anchor) {
  const before = anchor.getBoundingClientRect().top;
  layoutWorkLog({ from: workTopLevel(anchor), keepScroll: true });
  if (anchor.isConnected) el.messages.scrollTop += anchor.getBoundingClientRect().top - before;
}
function makeWorkHead() {
  const head = document.createElement("button");
  head.type = "button";
  head.className = "wl-own wl-head";
  head.dataset.i18nIgnore = "";
  const label = document.createElement("span");
  label.className = "wl-head-label";
  head.append(label, workChevron());
  head.addEventListener("click", () => {
    if (head.dataset.running === "true") return;
    const state = workLogState.turns.get(head.dataset.key);
    if (!state) return;
    state.expanded = !state.expanded;
    layoutWorkLogAround(head);
  });
  return head;
}
function makeWorkRow() {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "wl-own wl-row";
  row.dataset.i18nIgnore = "";
  const icon = document.createElement("span");
  icon.className = "wl-icon";
  icon.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "wl-label";
  row.append(icon, label, workChevron());
  row.addEventListener("click", () => {
    const key = row.dataset.key;
    if (!key) return;
    workLogState.segments.set(key, workLogState.segments.get(key) !== true);
    layoutWorkLogAround(row);
  });
  return row;
}
function makeWorkPulse() {
  const pulse = document.createElement("div");
  pulse.className = "wl-own wl-pulse";
  pulse.dataset.i18nIgnore = "";
  pulse.setAttribute("role", "status");
  return pulse;
}
function makeWorkFiles() {
  const card = document.createElement("section");
  card.className = "wl-own wl-files";
  card.dataset.i18nIgnore = "";
  return card;
}
function workStat(className, text) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}
function workTurnFiles(turn) {
  const files = new Map();
  for (const node of turn.nodes) {
    if (!node.classList.contains("msg")) continue;
    for (const card of node.querySelectorAll(".tool-card")) {
      if (card.classList.contains("err") || card.classList.contains("running")) continue;
      for (const change of window.stepsembleSessionUtils.toolEditChanges(card.__tool?.name, card.__tool?.args)) {
        const entry = files.get(change.path) || { path: change.path, added: 0, removed: 0 };
        entry.added += change.added;
        entry.removed += change.removed;
        files.set(change.path, entry);
      }
    }
  }
  return [...files.values()];
}
function workFileParts(path) {
  const cwd = String(currentSessionCwd || rpc?.cwd || "").replace(/[\\/]+$/, "");
  let value = String(path || "");
  if (cwd && (value.startsWith(cwd + "/") || value.startsWith(cwd + "\\"))) value = value.slice(cwd.length + 1);
  const cut = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  return { dir: cut >= 0 ? value.slice(0, cut + 1) : "", name: cut >= 0 ? value.slice(cut + 1) : value, relative: value };
}
async function openWorkFile(path) {
  if (!currentSessionCwd) return;
  const cwd = currentSessionCwd;
  const { relative } = workFileParts(path);
  await openProjectChanges();
  if (cwd !== currentSessionCwd || !projectChangesOpen()) return;
  const match = (projectChangesState?.data?.files || []).find(file => file.path === relative
    || relative.endsWith("/" + file.path) || file.path.endsWith("/" + relative));
  if (match) void loadProjectDiff(match.path);
}
function updateWorkFiles(card, files, state, turnKey) {
  const expanded = state.filesExpanded === true;
  const signature = JSON.stringify([files, expanded, turnKey, window.stepsembleI18n?.getLocale?.() || "en", !!currentSessionCwd]);
  if (card.dataset.signature === signature) return;
  card.dataset.signature = signature;
  const totals = files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
  const head = document.createElement("div");
  head.className = "wl-files-head";
  const icon = document.createElement("span");
  icon.className = "wl-files-icon";
  setWorkIcon(icon, "#i-diff");
  const copy = document.createElement("div");
  copy.className = "wl-files-copy";
  const title = document.createElement("strong");
  title.textContent = tKey(files.length === 1 ? "work.files.one" : "work.files.many", { count: files.length });
  const stat = document.createElement("span");
  stat.className = "wl-files-stat";
  stat.append(workStat("wl-add", "+" + totals.added), workStat("wl-del", "-" + totals.removed));
  copy.append(title, stat);
  head.append(icon, copy);
  if (currentSessionCwd) {
    const review = document.createElement("button");
    review.type = "button";
    review.className = "btn wl-files-review";
    review.textContent = tKey("work.files.review");
    review.addEventListener("click", () => openProjectChanges());
    head.appendChild(review);
  }
  const list = document.createElement("ul");
  list.className = "wl-files-list";
  for (const file of expanded ? files : files.slice(0, WORK_FILES_PREVIEW)) {
    const item = document.createElement("li");
    const row = document.createElement(currentSessionCwd ? "button" : "div");
    row.className = "wl-file";
    row.title = file.path;
    if (currentSessionCwd) {
      row.type = "button";
      row.addEventListener("click", () => openWorkFile(file.path));
    }
    const parts = workFileParts(file.path);
    const name = document.createElement("span");
    name.className = "wl-file-path";
    name.append(workStat("wl-file-dir", parts.dir), workStat("wl-file-name", parts.name));
    const fileStat = document.createElement("span");
    fileStat.className = "wl-file-stat";
    fileStat.append(workStat("wl-add", "+" + file.added), workStat("wl-del", "-" + file.removed));
    row.append(name, fileStat);
    item.appendChild(row);
    list.appendChild(item);
  }
  card.replaceChildren(head, list);
  const hidden = files.length - WORK_FILES_PREVIEW;
  if (hidden > 0) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "wl-files-more";
    more.setAttribute("aria-expanded", String(expanded));
    const label = document.createElement("span");
    label.textContent = expanded ? tKey("work.files.less")
      : tKey(hidden === 1 ? "work.files.more.one" : "work.files.more.many", { count: hidden });
    more.append(label, workChevron("#i-chevron-down"));
    more.addEventListener("click", () => {
      state.filesExpanded = !expanded;
      layoutWorkLogAround(more);
    });
    card.appendChild(more);
  }
}
function workSetHidden(block, hide) {
  if (block.node.nodeType === Node.ELEMENT_NODE) { block.node.classList.toggle("wl-hide", hide); return; }
  if (!hide || pendingAssistant?.textEl === block.node || !block.node.parentNode) return;
  // A reply cut off mid-stream stays a bare text node; wrap it so it can fold.
  const wrapper = document.createElement("div");
  wrapper.className = "md-body wl-hide";
  block.node.parentNode.insertBefore(wrapper, block.node);
  wrapper.appendChild(block.node);
}

function layoutWorkTurn(turn, key, { running = false, startedAt = null } = {}) {
  let state = workLogState.turns.get(key);
  if (!state) { state = { expanded: false, filesExpanded: false }; workLogState.turns.set(key, state); }
  const shells = turn.nodes.filter(node => node.classList.contains("msg") && directMessageBubble(node));
  const owned = [];
  for (const shell of shells) for (const node of directMessageBubble(shell).childNodes) if (workOwned(node)) owned.push(node);
  const used = new Set();
  const take = (className, create) => {
    const found = owned.find(node => node.classList.contains(className) && !used.has(node)) || create();
    used.add(found);
    return found;
  };
  const blocks = workTurnBlocks(turn);
  const segments = workSegments(blocks);
  let finalIndex = -1;
  if (!running) {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const kind = blocks[index].kind;
      if (kind === "text") { finalIndex = index; break; }
      if (kind === "work" || kind === "divider") break;
    }
  }
  const final = finalIndex >= 0 ? blocks[finalIndex] : null;
  const foldable = blocks.some((block, index) => index !== finalIndex && ["work", "divider", "text"].includes(block.kind));
  const showHead = shells.length > 0 && (running || foldable);
  const collapsed = !running && foldable && state.expanded !== true;

  if (showHead) {
    const head = take("wl-head", makeWorkHead);
    const bubble = directMessageBubble(shells[0]);
    if (bubble.firstChild !== head) bubble.insertBefore(head, bubble.firstChild);
    const started = running ? (startedAt || Number(turn.user?.dataset.wlStart) || Number(turn.user?.dataset.ts) || 0) : 0;
    const duration = running ? (started ? Math.max(0, Date.now() - started) : null) : workTurnDuration(turn);
    head.dataset.key = key;
    head.dataset.running = String(running);
    head.dataset.startedAt = started ? String(started) : "";
    head.classList.toggle("wl-running", running);
    head.classList.toggle("wl-collapsed", collapsed);
    if (running) { head.removeAttribute("aria-expanded"); head.tabIndex = -1; }
    else { head.setAttribute("aria-expanded", String(!collapsed)); head.tabIndex = 0; }
    const label = head.querySelector(".wl-head-label");
    const text = workHeadText(running, duration);
    if (label.textContent !== text) label.textContent = text;
  }

  const lastSegment = segments[segments.length - 1] || null;
  const lastBlock = blocks.filter(block => block.kind !== "empty" && block.kind !== "pulse").pop();
  const tailIsWork = !!lastSegment && lastBlock === lastSegment.blocks[lastSegment.blocks.length - 1];
  let liveCard = null;
  for (const segment of segments) {
    const segmentKey = key + ":" + workSegmentKey(segment);
    const expanded = workLogState.segments.get(segmentKey) === true;
    const first = segment.blocks[0].node;
    let row = first.previousSibling;
    if (!(workOwned(row) && row.classList.contains("wl-row") && !used.has(row))) {
      row = owned.find(node => node.classList.contains("wl-row") && node.dataset.key === segmentKey && !used.has(node)) || makeWorkRow();
      first.parentNode.insertBefore(row, first);
    }
    used.add(row);
    const items = workSegmentItems(segment);
    const live = running && segment === lastSegment && tailIsWork
      ? items.cards.find(card => card.classList.contains("running")) || null : null;
    if (live) liveCard = live;
    const summary = workSegmentSummary(items);
    const text = live ? toolTitle(live.__tool?.name, live.__tool?.args, true) : summary.text;
    row.dataset.key = segmentKey;
    row.setAttribute("aria-expanded", String(expanded));
    row.classList.toggle("wl-live", !!live);
    row.classList.toggle("wl-error", items.cards.some(card => card.classList.contains("err")));
    row.classList.toggle("wl-hide", collapsed);
    const label = row.querySelector(".wl-label");
    if (label.textContent !== text) label.textContent = text;
    row.title = text;
    setWorkIcon(row.querySelector(".wl-icon"), live
      ? WORK_ICONS[window.stepsembleSessionUtils.workCategory(live.__tool?.name, live.__tool?.args)] || WORK_ICONS.tool
      : summary.icon);
    for (const { node } of segment.blocks) {
      node.classList.add("wl-seg");
      if (node.matches(".activity-group") && !node.open) node.open = true;
      node.classList.toggle("wl-hide", collapsed || !expanded);
    }
  }

  for (const [index, block] of blocks.entries()) {
    if (block.kind === "work") continue;
    if (block.kind === "empty") { block.node.classList.add("wl-hide"); continue; }
    workSetHidden(block, collapsed && index !== finalIndex && (block.kind === "text" || block.kind === "divider"));
  }

  if (running && !liveCard && shells.length && !blocks.some(block => block.kind === "pulse"
    || block.kind === "notice" && block.node.matches?.(".agent-approval-card"))) {
    const pulse = take("wl-pulse", makeWorkPulse);
    const bubble = directMessageBubble(shells[shells.length - 1]);
    if (bubble.lastChild !== pulse) bubble.appendChild(pulse);
    const text = tKey("work.thinking");
    if (pulse.textContent !== text) pulse.textContent = text;
  }

  if (!running && shells.length) {
    const files = workTurnFiles(turn);
    if (files.length) {
      const card = take("wl-files", makeWorkFiles);
      const anchor = final?.node || null;
      const parent = anchor?.parentNode || directMessageBubble(shells[shells.length - 1]);
      if (anchor ? card.previousSibling !== anchor || card.parentNode !== parent : parent.lastChild !== card) {
        parent.insertBefore(card, anchor ? anchor.nextSibling : null);
      }
      updateWorkFiles(card, files, state, key);
    }
  }
  for (const node of owned) if (!used.has(node)) node.remove();

  for (const shell of shells) {
    const bubble = directMessageBubble(shell);
    const visible = [...bubble.childNodes].some(child => child.nodeType === Node.TEXT_NODE
      ? !!String(child.textContent || "").trim()
      : child.nodeType === Node.ELEMENT_NODE && !child.classList.contains("wl-hide") && !child.classList.contains("hidden"));
    shell.classList.toggle("wl-hide", !visible);
    shell.classList.toggle("wl-turn", showHead);
    for (const child of shell.children) {
      if (child.classList.contains("msg-actions")) child.classList.toggle("wl-hide", showHead && (running || final?.shell !== shell));
      else if (child.classList.contains("message-usage")) child.classList.toggle("wl-hide", showHead);
    }
  }
}

function layoutWorkLog({ from = null, tail = false, keepScroll = false } = {}) {
  if (!el.messages) return;
  if (workLogState.generation !== viewGeneration) {
    workLogState.generation = viewGeneration;
    workLogState.turns.clear();
    workLogState.segments.clear();
    workLogState.ids = new WeakMap();
    workLogState.sequence = 0;
    from = null;
    tail = false;
  }
  const turns = workTurns();
  const run = workLogRunState();
  const seen = new Map();
  turns.forEach((turn, index) => {
    const key = workTurnKey(turn, index, seen);
    const last = index === turns.length - 1;
    const start = turn.user || turn.nodes[0];
    const include = (!from && !tail) || (tail && last) || (!!from && (turn.user === from || turn.nodes.includes(from)
      || !!start && !!(from.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING)));
    if (include) layoutWorkTurn(turn, key, { running: run.running && last, startedAt: run.startedAt });
  });
  workLogState.observer?.takeRecords();
  if (!keepScroll && autoScrollPinned) el.messages.scrollTop = el.messages.scrollHeight;
}

// Renderer changes arrive as DOM mutations; batch them into one layout per
// frame and only revisit the turns they touched.
function scheduleWorkLog(scope = null) {
  if (!el.messages) return;
  const pending = workLogState.scope || (workLogState.scope = { all: false, tail: false, from: null });
  if (scope === "tail") pending.tail = true;
  else if (scope?.nodeType) {
    if (!pending.from || !pending.from.isConnected
      || (scope.compareDocumentPosition(pending.from) & Node.DOCUMENT_POSITION_FOLLOWING)) pending.from = scope;
  } else pending.all = true;
  if (workLogState.frame) return;
  workLogState.frame = requestAnimationFrame(() => {
    workLogState.frame = null;
    const next = workLogState.scope;
    workLogState.scope = null;
    if (!next) return;
    if (next.all || (next.from && !next.from.isConnected)) layoutWorkLog();
    else if (next.from) layoutWorkLog({ from: next.from });
    else if (next.tail) layoutWorkLog({ tail: true });
  });
}
function updateWorkLogClock() {
  for (const head of el.messages?.querySelectorAll?.(".wl-head.wl-running") || []) {
    const startedAt = Number(head.dataset.startedAt) || 0;
    const label = head.querySelector(".wl-head-label");
    const text = workHeadText(true, startedAt ? Math.max(0, Date.now() - startedAt) : null);
    if (label && label.textContent !== text) label.textContent = text;
  }
}
function relabelWorkLog() {
  for (const card of el.messages?.querySelectorAll?.(".tool-card") || []) {
    const meta = card.__tool || {};
    const title = card.querySelector(".tool-name");
    if (!title) continue;
    title.textContent = toolTitle(meta.name, meta.args, card.classList.contains("running"));
    title.title = toolTitle(meta.name, meta.args, false);
  }
  for (const toggle of el.messages?.querySelectorAll?.(".thinking-toggle") || []) toggle.textContent = tKey("work.item.thinking");
  for (const card of el.messages?.querySelectorAll?.(".wl-files") || []) delete card.dataset.signature;
  layoutWorkLog({ keepScroll: true });
}
function observeWorkLog() {
  if (workLogState.observer || !el.messages || typeof MutationObserver !== "function") return;
  workLogState.observer = new MutationObserver(records => {
    for (const record of records) {
      const changed = [...record.addedNodes, ...record.removedNodes].filter(node => !workOwned(node));
      if (!changed.length) continue;
      const target = record.target;
      if (target === el.messages) {
        for (const node of changed) {
          if (node.nodeType !== Node.ELEMENT_NODE || !(node.classList.contains("msg") || node.classList.contains("context-divider"))) continue;
          if (node.isConnected) scheduleWorkLog(node);
          else if (record.previousSibling?.isConnected) scheduleWorkLog(record.previousSibling);
          else if (record.nextSibling?.isConnected) scheduleWorkLog(record.nextSibling);
          else scheduleWorkLog();
        }
        continue;
      }
      if (target.nodeType !== Node.ELEMENT_NODE
        || !(target.classList.contains("bubble") || target.classList.contains("activity-body") || target.classList.contains("msg"))) continue;
      const top = workTopLevel(target);
      if (top) scheduleWorkLog(top);
    }
  });
  workLogState.observer.observe(el.messages, { childList: true, subtree: true });
}
observeWorkLog();


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
  if (!rpc?.sid || rpc.generic) return;
  if (extensionUiRequest) { refreshNativeDialogControls(); return; }
  const next = nativeDialogs.next(apiBase, rpc.sid);
  if (next) renderNativeDialog(next);
}
async function finishExtensionUi(response, expected = extensionUiRequest) {
  const request = extensionUiRequest;
  if (!request || request !== expected) return;
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
  // A quiet stretch is normal for long commands and slow models. The live
  // work row keeps shimmering while the run is alive, so no text warning is
  // shown here; clear one left by an older client instead.
  if (el.queueNote?.dataset.persistent === "stale") {
    clearActivityNote();
    el.queueNote.classList.add("hidden");
  }
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
  if (rpc?.nativeCodex) renderCodexNativeRunState(rpc);
  updateWorkLogClock();
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
        stampMessageTime(wrap, m.timestamp || Date.now());
        bubble.innerHTML = "";
        // The streamed preview is replaced by the authoritative message_end
        // snapshot; discard detached card references before rebuilding it.
        liveToolCards = new Map();
        liveActivity = null;
        // Thinking, then prose, then tool calls — the order Pi produced them.
        if (full.thinking) ensureActivityGroup({ bubble, running: false })?.body.appendChild(makeThinking(full.thinking));
        if (full.text) bubble.appendChild(renderMarkdown(full.text));
        // Pi emits message_end before tool_execution_start. Keep tool rows in
        // the running state so the next execution events can update them.
        for (const tc of full.toolCalls) {
          const card = appendLiveToolCard(tc.id, tc.name, tc.args);
          if (card) card.dataset.toolCallId = tc.id || "";
        }
        if (full.usage) {
          attachMessageUsage(wrap, full.usage, lastWorkActivity(bubble));
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
  const wasStreaming = !!rpc?.streaming;
  el.btnAbort.disabled = !!rpc?.stopPending;
  syncGenericInputState();
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
  if (!on && wasStreaming) stampWorkTurnEnd();
  scheduleWorkLog("tail");
  el.thinkingStatus?.classList.toggle("hidden", !on);
  el.thinkingStatus?.classList.toggle("running", !!on && rpc?.activityLabel !== "waiting");
  el.btnAbort.classList.toggle("hidden", !on);
  // Interactive CLI agents accept follow-up input while they are alive, so
  // keep Send available for them. Pi's native RPC retains its queue/abort UX.
  el.btnSend.classList.toggle("hidden", on && !generic);
  // OpenCode/ACP expose a live model route; Claude owns a session-scoped model
  // endpoint and Codex applies the selected model on its next prompt. Other
  // connectors have no safe model route, and read-only history must not offer
  // to change anything.
  el.btnModel?.classList.toggle("hidden", !connectorAllowsLiveControls(rpc));
  // Attachments follow the connector's wire format, not the Pi/generic split:
  // OpenCode, Claude Code and the ACP agents all carry image content blocks.
  el.btnImg?.classList.toggle("hidden", !connectorAcceptsImages(rpc));
  // The gauge is driven by whatever usage the connector reports: OpenCode
  // supplies per-turn token counts and ACP returns them on the prompt reply.
  el.contextDashboard?.classList.toggle("hidden", !rpc);
  if (el.thinkingSelect) {
    const codex = !!rpc?.nativeCodexMutation;
    const claude = !!rpc?.nativeClaudeStructured;
    if (codex || claude) syncNativeThinkingSelect(rpc);
    else el.thinkingSelect.disabled = false;
    if (codex && rpc.codexEffort) el.thinkingSelect.value = rpc.codexEffort;
  }
  el.btnSend.title = on ? "" : (window.stepsembleI18n?.t("Send") || "Send");
  el.btnAbort.title = on ? (window.stepsembleI18n?.t("Stop") || "Stop") : "";
  // An agent can change its own mode during a turn (Claude leaves plan mode
  // once a plan is approved), so read it again when a turn ends.
  if (!on && wasStreaming && rpc && approvalTarget(rpc)) void loadApprovalModes(rpc);
  syncApprovalControl();
}

// ---- 送出 / 中止 ----
el.btnSend.addEventListener("click", sendCurrent);
el.btnModel.addEventListener("click", openModelSheet);
const composerIme = window.stepsembleComposerIme?.createGuard();
el.input.addEventListener("compositionstart", () => composerIme?.compositionStart());
el.input.addEventListener("compositionend", () => composerIme?.compositionEnd());
el.input.addEventListener("blur", () => composerIme?.blur());
el.input.addEventListener("keydown", (e) => {
  const imeEnter = composerIme?.classifyEnter(e) || { ime: e.key === "Enter" && e.isComposing, preventDefault: false };
  if (imeEnter.ime) {
    if (imeEnter.preventDefault) e.preventDefault();
    return;
  }
  // slash 選單鍵盤導航
  if (slashState && el.slashMenu && !el.slashMenu.classList.contains("hidden")) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      slashState.hl = (slashState.hl + (e.key === "ArrowDown" ? 1 : -1) + slashState.items.length) % slashState.items.length;
      [...el.slashMenu.children].forEach((c, i) => c.classList.toggle("hl", i === slashState.hl));
      return;
    }
    if (e.key === "Tab" || e.key === "Enter") {
      e.preventDefault();
      pickSlash(slashState.items[slashState.hl]);
      return;
    }
    if (e.key === "Escape") { el.slashMenu.classList.add("hidden"); slashState = null; return; }
  }
  // 手機（coarse pointer）：Enter 一律換行，發送只靠按鈕；桌面 Enter 發送
  const isDesktop = matchMedia("(min-width: 980px)").matches;
  if (e.key === "Enter" && !e.shiftKey && isDesktop) { e.preventDefault(); sendCurrent(); }
});
el.input.addEventListener("input", () => {
  resizeComposerInput();
  saveActiveDraft();
  updateSlashMenu();
});

// ---- 圖片附件（手機拍照／相冊／剪貼簿貼上 → base64）----
let pendingImages = []; // [{data, mimeType}]
const MAX_IMAGE_FILE_BYTES = 24 * 1024 * 1024;
// Mirrors server/prompt-attachments.js. Claude's API documents 100 images per
// request; the other agents publish no number and share 20. ACP agents read a
// prompt as one stdin line, so their total image budget is smaller.
const COMPOSER_IMAGE_BUDGETS = Object.freeze({
  claude: Object.freeze({ count: 100, bytes: 24 * 1024 * 1024 }),
  acp: Object.freeze({ count: 20, bytes: 10 * 1024 * 1024 }),
  standard: Object.freeze({ count: 20, bytes: 24 * 1024 * 1024 }),
});
function composerImageBudget(connection = rpc) {
  if (connection?.nativeClaudeStructured) return COMPOSER_IMAGE_BUDGETS.claude;
  if (connection?.nativeAcp || connection?.nativeGrokAcp) return COMPOSER_IMAGE_BUDGETS.acp;
  return COMPOSER_IMAGE_BUDGETS.standard;
}
function imageDataBytes(image) {
  return String(image?.data || "").replace(/^data:[^,]*,/, "").length;
}

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
  const budget = composerImageBudget();
  let added = 0;
  let limit = null;
  for (const file of Array.from(files || [])) {
    if (!file?.type?.startsWith("image/")) continue;
    if (pendingImages.length >= budget.count) { limit = "count"; break; }
    try {
      const image = await imageFileToDataUrl(file);
      const used = pendingImages.reduce((sum, item) => sum + imageDataBytes(item), 0);
      if (used + imageDataBytes(image) > budget.bytes) { limit = "bytes"; break; }
      pendingImages.push(image);
      added++;
      renderImgPreview();
    } catch (error) {
      toast(error.message || "圖片處理失敗", true);
    }
  }
  if (limit === "count") toast(tKey("composer.imageLimit", { count: budget.count }), true);
  else if (limit === "bytes") toast(tKey("composer.imageBytesLimit", { size: Math.round(budget.bytes / 1024 / 1024) }), true);
  else if (added) toast(`${added} 張圖片已加入`);
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
  for (const dataUrl of urls.slice(0, composerImageBudget().count)) {
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
    // The thumbnail opens the same viewer as a sent image: close with ×,
    // a click outside the image, or Escape.
    const open = document.createElement("button");
    open.type = "button";
    open.className = "img-thumb-open";
    const label = tKey("composer.previewImage", { index: i + 1 });
    open.title = label;
    open.setAttribute("aria-label", label);
    const img = document.createElement("img");
    img.src = im.data;
    img.alt = "";
    open.appendChild(img);
    open.addEventListener("click", () => openImageLightbox({ data: im.data, mimeType: im.mimeType }, label, open));
    const x = document.createElement("button");
    x.className = "img-x";
    x.type = "button";
    x.title = "移除圖片";
    x.setAttribute("aria-label", "移除圖片");
    x.textContent = "×";
    x.addEventListener("click", () => { pendingImages.splice(i, 1); renderImgPreview(); });
    wrap.appendChild(open); wrap.appendChild(x);
    el.imgPreview.appendChild(wrap);
  });
}

async function sendCurrent() {
  let text = el.input.value.trim();
  // /login, /logout and /status run the agent's own commands in the
  // conversation terminal, even when the conversation cannot take input.
  const terminalCommand = agentTerminalApi?.parseCommand(text);
  const terminalAgent = terminalCommand && !pendingImages.length ? conversationAgentId() : null;
  if (terminalCommand && terminalAgent) {
    el.input.value = "";
    el.input.style.height = "auto";
    el.slashMenu.classList.add("hidden");
    slashState = null;
    removeDraftForKey(activeDraftKey);
    void openAgentTerminal({ agentId: terminalAgent, action: terminalCommand.action, argument: terminalCommand.argument });
    return;
  }
  if ((!text && !pendingImages.length) || !rpc) return;
  const generic = !!rpc.generic;
  const inputBlock = genericInputBlock();
  if (inputBlock) { toast(agentHubText(inputBlock), true); return; }
  if (generic && pendingImages.length && !connectorAcceptsImages(rpc)) {
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

  // Codex's own item replaces this echo (reconcileCodexNativeEchoes) and its
  // transcript has no date lines, so native Codex skips the separator.
  const codexNativeSend = rpc.nativeCodexMutation ? rpc : null;
  if (!codexNativeSend) maybeDateSeparator(Date.now());
  lastUserText = text;
  const { wrap: userShell, bubble } = makeMsgShell("user", "你");
  userShell.dataset.ts = String(Date.now());
  if (text) bubble.appendChild(renderMarkdown(text));
  if (pendingImages.length) appendImageGallery(bubble, pendingImages, pendingImages.length);
  const codexEcho = codexNativeSend ? trackCodexNativeEcho(codexNativeSend, userShell, text) : null;
  if (generic && !rpc.nativeOpenCode && text && Array.isArray(rpc.genericInputEchoes)) {
    rpc.genericInputEchoes.push({ text, at: Date.now() });
    if (rpc.genericInputEchoes.length > 32) rpc.genericInputEchoes.shift();
  }
  scrollBottom();
  const sendSid = rpc.sid;
  const images = pendingImages.slice();
  pendingImages = [];
  renderImgPreview();
  try {
    const result = generic
      ? (rpc?.nativeOpenCode
        ? await post("/api/opencode/message", { sessionId: rpc.nativeSessionId, cwd: rpc.cwd, text, images, model: currentOpenCodeModelPayload(rpc.openCodeModel) })
        : rpc?.nativeGrokAcp
          ? await post("/api/grok/acp/prompt", { sessionId: rpc.nativeSessionId, cwd: rpc.cwd, text, images })
          : rpc?.nativeAcp
            ? await post(`/api/${rpc.acpAgentId}/acp/prompt`, { sessionId: rpc.nativeSessionId, cwd: rpc.cwd, text, images })
          : rpc?.nativeClaudeStructured
            ? await post("/api/claude/structured/prompt", { sessionId: rpc.nativeSessionId, cwd: rpc.cwd, text, images })
          : rpc?.nativeAntigravityStructured
              ? await post("/api/antigravity/structured/prompt", { sessionId: rpc.nativeSessionId, cwd: rpc.cwd, text })
            : rpc?.nativeCodexMutation
              ? await post("/api/codex/mutation/turn", {
                threadId: rpc.nativeThreadId,
                cwd: rpc.cwd,
                text,
                images,
                ...(rpc.codexModel?.id ? { model: rpc.codexModel.id } : {}),
                ...(rpc.codexEffort && rpc.codexEffort !== "off" ? { effort: rpc.codexEffort } : {}),
              })
          : await post("/api/agent/send", { taskId: sendSid, message: text }))
      : await post("/api/send", { sid: sendSid, message: text, images }); // /skill:xxx 等直接透傳，pi 原生處理
    removeDraftForKey(sendDraftKey);
    if (codexEcho) {
      codexEcho.turnId = result?.turnId || result?.completedTurnId || null;
      reconcileCodexNativeEchoes(codexNativeSend);
    }
    if (rpc?.sid === sendSid && !rpc.approval && approvalTarget(rpc)) void loadApprovalModes(rpc);
    // ACP reports the turn's token usage on this reply, not in its event
    // stream, so the context gauge is updated from here.
    if (rpc?.nativeAcp && rpc.sid === sendSid) applyAcpContextStats(result, rpc);
    if ((rpc?.nativeCodexMutation || rpc?.nativeClaudeStructured) && rpc.sid === sendSid) {
      void syncNativeContext(rpc);
    }
    if (rpc?.nativeCodexMutation && rpc.sid === sendSid && ["started", "requested"].includes(result?.kind)) {
      rpc.taskStatus = "running";
      setStreaming(true);
      if (!codexNativePollTimer) codexNativePollTimer = setInterval(() => void refreshCodexNativeSnapshot(rpc), 2500);
    }
    if (result?.queued && rpc?.sid === sendSid) {
      el.queueNote.dataset.persistent = "queue";
      el.queueNote.textContent = tKey("runtime.messageQueued");
      el.queueNote.classList.remove("hidden");
    }
  } catch (e) {
    // The text goes back to the composer, so the echo would be a duplicate.
    if (codexEcho) dropCodexNativeEcho(codexNativeSend, codexEcho);
    if (rpc?.sid === sendSid) {
      if (generic && Array.isArray(rpc.genericInputEchoes)) {
        const echoIndex = rpc.genericInputEchoes.findIndex(item => item.text === text);
        if (echoIndex >= 0) rpc.genericInputEchoes.splice(echoIndex, 1);
      }
      el.input.value = text;
      resizeComposerInput();
      saveDraftForKey(sendDraftKey, text);
      pendingImages = images.concat(pendingImages).slice(0, composerImageBudget().count);
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
  if (connection.generic) syncGenericInputState();
  try {
    if (connection.nativeOpenCode) await post("/api/opencode/abort", { sessionId: connection.nativeSessionId, cwd: connection.cwd });
    else if (connection.nativeGrokAcp) await post("/api/grok/acp/cancel", { sessionId: connection.nativeSessionId });
    else if (connection.nativeAcp) await post(`/api/${connection.acpAgentId}/acp/cancel`, { sessionId: connection.nativeSessionId });
    else if (connection.nativeClaudeStructured) await post("/api/claude/structured/interrupt", { sessionId: connection.nativeSessionId });
    else if (connection.nativeAntigravityStructured) await post("/api/agent/close", { taskId: connection.sid });
    else if (connection.nativeCodexMutation) await post("/api/codex/mutation/interrupt", { threadId: connection.nativeThreadId });
    else if (connection.generic) await post("/api/agent/abort", { taskId: connection.sid });
    else await post("/api/abort", { sid: connection.sid });
  } catch (error) {
    if (rpc === connection && apiBase === base) toast(error.message || agentHubText("taskStopFailed"), true);
  } finally {
    connection.stopPending = false;
    if (rpc === connection && apiBase === base) { el.btnAbort.disabled = false; if (connection.generic) syncGenericInputState(); }
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
  setApprovalMenu(false);
  el.approvalControl?.classList.add("hidden");
  composerModelName = "";
  composerReasoningLevel = "off";
  availableModels = [];
  modelSheetCurrentId = null;
  modelSheetCurrentProvider = null;
  if (el.thinkingSelect) {
    captureDefaultThinkingSelectOptions();
    restoreDefaultThinkingSelectOptions();
    setThinkingControlVisibility(false);
    el.thinkingSelect.value = "off";
    el.thinkingSelect.disabled = false;
  }
  resetContextDashboard();
  updateComposerSummary();
}
function updateComposerSummary(modelName, thinkingLevel) {
  if (modelName !== undefined) composerModelName = String(modelName || "");
  // An empty level is the explicit "this model has no thinking control"
  // signal, so it must clear the chip instead of leaving the level the
  // previously selected model was using on screen.
  if (thinkingLevel !== undefined) composerReasoningLevel = String(thinkingLevel || "");
  const model = composerModelName || (window.stepsembleI18n?.t("Server default") || "Server default");
  const level = composerReasoningLevel || "off";
  const levelLabel = !composerReasoningLevel ? ""
    : (rpc?.nativeCodexMutation || rpc?.nativeClaudeStructured) && (level === "off" || level === "auto") ? "Default" : level;
  const summary = levelLabel ? `${model} · ${levelLabel}` : model;
  // The chip is fixed-width: the model name truncates with an ellipsis while
  // the trailing thinking level always stays fully visible.
  if (el.composerModelNameText) {
    el.composerModelNameText.textContent = model;
    el.composerModelNameText.title = model;
  }
  if (el.composerModelLevelText) {
    el.composerModelLevelText.textContent = levelLabel ? reasoningLevelText(levelLabel) : "";
    el.composerModelLevelText.classList.toggle("hidden", !levelLabel);
  }
  if (el.btnModel) {
    const label = window.stepsembleI18n?.t("Model & reasoning") || "Model & reasoning";
    el.btnModel.title = label;
    el.btnModel.setAttribute("aria-label", `${label}: ${summary}`);
  }
}
// Levels read the way Codex shows them beside the model: "Medium", "Max".
function reasoningLevelText(level) {
  const value = String(level || "");
  if (value === "xhigh") return "Extra high";
  return value.charAt(0).toUpperCase() + value.slice(1);
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
let defaultThinkingSelectOptions = null;

const CODEX_EFFORTS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const THINKING_LEVEL_ORDER = Object.freeze(["low", "medium", "high", "xhigh", "max"]);

function captureDefaultThinkingSelectOptions() {
  if (!el.thinkingSelect || defaultThinkingSelectOptions) return;
  defaultThinkingSelectOptions = [...el.thinkingSelect.options].map(option => ({ value: option.value, label: option.textContent }));
}

function restoreDefaultThinkingSelectOptions() {
  if (!el.thinkingSelect || !defaultThinkingSelectOptions) return;
  const same = [...el.thinkingSelect.options].length === defaultThinkingSelectOptions.length
    && [...el.thinkingSelect.options].every((option, index) => option.value === defaultThinkingSelectOptions[index].value
      && option.textContent === defaultThinkingSelectOptions[index].label);
  if (!same) {
    el.thinkingSelect.replaceChildren(...defaultThinkingSelectOptions.map(({ value, label }) => {
      const option = document.createElement("option"); option.value = value; option.textContent = label; return option;
    }));
  }
}

function setThinkingControlVisibility(hidden) {
  const select = el.thinkingSelect;
  if (!select) return;
  select.hidden = !!hidden;
  document.querySelector('label[for="thinking-select"]')?.classList.toggle("hidden", !!hidden);
  if (hidden) setThinkingHint("");
  const heading = el.modelSheet?.querySelector?.(".model-heading h2");
  if (heading) heading.textContent = hidden ? "Model" : "Model & reasoning";
}

// The reasoning row explains itself when the selected model has no thinking
// control at all (Claude's Haiku, for example), so a disabled select never
// looks like a broken control.
function setThinkingHint(text) {
  if (!el.thinkingHint) return;
  const message = String(text || "");
  el.thinkingHint.textContent = message;
  el.thinkingHint.classList.toggle("hidden", !message);
}

// Codex reasoning options are model-scoped and may include levels absent from
// the Pi-oriented static select (for example max/ultra). Keep the static Pi
// options intact when leaving Codex so another connector sees its normal menu.
function syncNativeThinkingSelect(connection = rpc) {
  const select = el.thinkingSelect;
  if (!select) return;
  captureDefaultThinkingSelectOptions();
  setThinkingHint("");
  if (connection?.nativeClaudeStructured) {
    const model = connection.claudeModel;
    const advertised = Array.isArray(model?.supportedEffortLevels)
      ? model.supportedEffortLevels.map(level => String(level).trim().toLowerCase()).filter(level => THINKING_LEVEL_ORDER.includes(level))
      : [];
    const supportsEffort = model?.supportsEffort === true || advertised.length > 0;
    if (!supportsEffort) {
      setThinkingControlVisibility(false);
      const option = document.createElement("option");
      option.value = "default";
      option.textContent = "Default";
      select.replaceChildren(option);
      select.value = "default";
      select.disabled = true;
      select.title = tKey("runtime.thinkingUnsupported");
      setThinkingHint(tKey("runtime.thinkingUnsupported"));
      // The model keeps running at its own default, so the chip must not keep
      // advertising the level chosen for a different model.
      updateComposerSummary(undefined, "");
      return;
    }
    setThinkingControlVisibility(false);
    select.disabled = false;
    select.removeAttribute("title");
    const choicesForModel = advertised.length ? advertised : [...THINKING_LEVEL_ORDER];
    const levels = ["auto", ...new Set(choicesForModel)];
    select.replaceChildren(...levels.map(level => {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = level === "auto" ? "Default" : level;
      return option;
    }));
    const choices = new Set(levels);
    const requested = String(connection.claudeEffort || model.defaultEffort || "auto").toLowerCase();
    connection.claudeEffort = choices.has(requested) ? requested : "auto";
    select.value = connection.claudeEffort;
    updateComposerSummary(undefined, connection.claudeEffort);
    return;
  }
  setThinkingControlVisibility(false);
  if (!connection?.nativeCodexMutation) {
    restoreDefaultThinkingSelectOptions();
    select.disabled = false;
    return;
  }
  const model = connection.codexModel;
  const advertised = Array.isArray(model?.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.map(String).filter(level => CODEX_EFFORTS.includes(level))
    : [];
  const levels = [...new Set(["off", ...advertised])];
  // A catalog that omits reasoning metadata keeps the familiar static menu;
  // an explicit list is authoritative and gets its own compact select.
  if (advertised.length || model?.reasoningEffortsDeclared === true) {
    select.replaceChildren(...levels.map(level => {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = level === "off" ? "Default" : level;
      return option;
    }));
  } else {
    restoreDefaultThinkingSelectOptions();
  }
  const choices = new Set([...select.options].map(option => option.value));
  const current = String(connection.codexEffort || "off");
  const modelDefault = String(model?.defaultReasoningEffort || "").trim();
  const next = choices.has(current) ? current : choices.has(modelDefault) ? modelDefault : "off";
  connection.codexEffort = next;
  select.value = next;
  select.disabled = false;
}

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

// ---- Approval mode (composer) ----
// Each agent's own approval modes, beside the attachment button as in Codex.
// The Host reports the modes the agent offers and the one in use, and applies
// a change the way that agent expects. Pi and terminal sessions have none.
function approvalTarget(connection = rpc) {
  if (!connection || connection.readOnly === true || connection.nativeHistoryReadonly === true) return null;
  if (connection.nativeCodexMutation && connection.nativeThreadId) return { agentId: "codex", sessionId: connection.nativeThreadId };
  if (connection.nativeClaudeStructured && connection.nativeSessionId) return { agentId: "claude-code", sessionId: connection.nativeSessionId };
  if (connection.nativeOpenCode && connection.nativeSessionId) return { agentId: "opencode", sessionId: connection.nativeSessionId };
  if (connection.nativeAcp && connection.acpAgentId && connection.nativeSessionId) return { agentId: connection.acpAgentId, sessionId: connection.nativeSessionId };
  if (connection.nativeGrokAcp && connection.nativeSessionId) return { agentId: "grok-build", sessionId: connection.nativeSessionId };
  return null;
}

// Codex and Claude Code modes use Stepsemble's translated names; OpenCode and
// the ACP agents name their own modes.
function approvalModeText(agentId, mode) {
  const keys = agentId === "codex"
    ? { "read-only": "codex.readOnly", workspace: "codex.workspace", "full-access": "codex.fullAccess", custom: "codex.custom" }
    : agentId === "claude-code"
      ? { default: "claude.manual", acceptEdits: "claude.acceptEdits", plan: "claude.plan", auto: "claude.auto", dontAsk: "claude.dontAsk", bypassPermissions: "claude.bypass" }
      // Grok Build's two modes mean the same as Claude Code's.
      : agentId === "grok-build" ? { default: "claude.manual", plan: "claude.plan" } : {};
  const key = Object.hasOwn(keys, mode?.id) ? keys[mode.id] : null;
  // Claude Code's own short titles keep the chip readable on a phone.
  const short = key === "claude.acceptEdits" || key === "claude.bypass" ? tKey("approval." + key + ".short") : null;
  if (key) return { label: tKey("approval." + key), short: short || tKey("approval." + key), description: tKey("approval." + key + ".note") };
  const label = String(mode?.label || mode?.id || "");
  return { label: label.charAt(0).toUpperCase() + label.slice(1), description: String(mode?.description || "") };
}

function approvalModeTone(agentId, id) {
  if (agentId === "codex") return id === "full-access" ? "warn" : "";
  if (agentId === "claude-code") return id === "bypassPermissions" ? "warn" : "";
  return /bypass|yolo|full[-_ ]?access|danger|skip[-_ ]?permission/i.test(String(id || "")) ? "warn" : "";
}

async function loadApprovalModes(connection = rpc) {
  if (!connection) return;
  const target = approvalTarget(connection);
  if (!target) { connection.approval = null; if (connection === rpc) renderApprovalControl(); return; }
  const base = apiBase, sequence = (connection.approvalRequest || 0) + 1;
  connection.approvalRequest = sequence;
  let approval = null;
  try {
    const query = new URLSearchParams({ agentId: target.agentId, sessionId: target.sessionId });
    if (connection.cwd) query.set("cwd", connection.cwd);
    const data = await api("/api/agent-mode?" + query.toString());
    approval = data?.supported && Array.isArray(data.modes) && data.modes.length ? { ...data, target } : null;
  } catch {}
  if (connection.approvalRequest !== sequence || apiBase !== base) return;
  connection.approval = approval;
  if (connection === rpc) renderApprovalControl();
}

function syncApprovalControl() {
  const connection = rpc;
  if (connection && !connection.approvalLoaded && approvalTarget(connection)) {
    connection.approvalLoaded = true;
    void loadApprovalModes(connection);
  }
  renderApprovalControl();
}

function renderApprovalControl() {
  if (!el.approvalControl || !el.btnApproval) return;
  const approval = rpc?.approval;
  const visible = !!approval && connectorAllowsLiveControls(rpc);
  el.approvalControl.classList.toggle("hidden", !visible);
  if (!visible) { setApprovalMenu(false); return; }
  const current = approval.modes.find(mode => mode.id === approval.current) || (approval.current ? { id: approval.current } : null);
  const text = current ? approvalModeText(approval.agentId, current) : { label: tKey("approval.title"), description: "" };
  const tone = current ? approvalModeTone(approval.agentId, current.id) : "";
  el.approvalControl.dataset.tone = tone;
  el.approvalLabel.textContent = window.matchMedia?.("(max-width: 600px)")?.matches ? text.short || text.label : text.label;
  el.btnApproval.querySelector("use")?.setAttribute("href", tone === "warn" ? "#i-shield-alert" : "#i-shield");
  const label = tKey("approval.title") + ": " + text.label;
  el.btnApproval.title = label;
  el.btnApproval.setAttribute("aria-label", label);
  el.btnApproval.disabled = !!approval.pending;
  if (!el.approvalMenu.classList.contains("hidden")) renderApprovalMenu();
}

function renderApprovalMenu() {
  const approval = rpc?.approval;
  if (!approval || !el.approvalOptions) return;
  const known = new Set(approval.modes.map(mode => mode.id));
  // A mode set outside Stepsemble (Codex's config.toml, say) is listed too.
  const modes = approval.current && !known.has(approval.current) ? [...approval.modes, { id: approval.current }] : approval.modes;
  el.approvalOptions.replaceChildren(...modes.map(mode => {
    const text = approvalModeText(approval.agentId, mode);
    const option = document.createElement("button");
    option.type = "button";
    option.className = "approval-option";
    option.setAttribute("role", "menuitemradio");
    option.setAttribute("aria-checked", String(mode.id === approval.current));
    option.dataset.mode = mode.id;
    const tone = approvalModeTone(approval.agentId, mode.id);
    if (tone) option.dataset.tone = tone;
    option.disabled = !!approval.pending || !known.has(mode.id);
    const check = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    check.setAttribute("class", "icon");
    check.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "#i-check");
    check.appendChild(use);
    const name = document.createElement("strong");
    name.textContent = text.label;
    option.append(check, name);
    if (text.description) {
      const note = document.createElement("small");
      note.textContent = text.description;
      option.appendChild(note);
    }
    option.addEventListener("click", () => void chooseApprovalMode(mode.id));
    return option;
  }));
  el.approvalMenuNote?.classList.toggle("hidden", !approval.appliesNextTurn);
}

function setApprovalMenu(open) {
  if (!el.approvalMenu || !el.btnApproval) return;
  const show = !!open && !!rpc?.approval;
  if (show) renderApprovalMenu();
  el.approvalMenu.classList.toggle("hidden", !show);
  el.btnApproval.setAttribute("aria-expanded", String(show));
  if (show) (el.approvalOptions.querySelector('[aria-checked="true"]:not(:disabled)') || el.approvalOptions.querySelector("button:not(:disabled)"))?.focus({ preventScroll: true });
}

function approvalErrorText(error) {
  const code = String(error?.code || error?.message || "");
  if (code === "claude_bypass_unavailable") return tKey("approval.bypassUnavailable");
  if (code === "claude_bypass_helper_outdated") return tKey("approval.bypassHelperOutdated");
  if (/prompt_in_flight|model_switch_active/.test(code)) return tKey("approval.busy");
  return tKey("approval.failed", { detail: code || "unknown error" });
}

async function chooseApprovalMode(id) {
  const connection = rpc, approval = connection?.approval, base = apiBase;
  if (!approval || approval.pending) return;
  if (approval.current === id) { setApprovalMenu(false); el.btnApproval?.focus(); return; }
  approval.pending = true;
  renderApprovalControl();
  try {
    const data = await post("/api/agent-mode", { ...approval.target, mode: id, ...(connection.cwd ? { cwd: connection.cwd } : {}) });
    if (rpc !== connection || apiBase !== base) return;
    if (data?.supported && Array.isArray(data.modes) && data.modes.length) connection.approval = { ...data, target: approval.target };
    setApprovalMenu(false);
    el.btnApproval?.focus();
  } catch (error) {
    if (rpc === connection && apiBase === base) toast(approvalErrorText(error), true);
  } finally {
    approval.pending = false;
    if (connection.approval) connection.approval.pending = false;
    if (rpc === connection) renderApprovalControl();
  }
}

window.matchMedia?.("(max-width: 600px)")?.addEventListener?.("change", () => renderApprovalControl());
el.btnApproval?.addEventListener("click", (event) => {
  event.stopPropagation();
  setApprovalMenu(el.approvalMenu?.classList.contains("hidden"));
});
el.approvalMenu?.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    setApprovalMenu(false);
    el.btnApproval?.focus();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const options = [...el.approvalOptions.querySelectorAll("button:not(:disabled)")];
  if (!options.length) return;
  event.preventDefault();
  const index = options.indexOf(document.activeElement);
  const next = event.key === "ArrowDown" ? (index + 1) % options.length : (index <= 0 ? options.length - 1 : index - 1);
  options[next].focus({ preventScroll: true });
});
document.addEventListener("click", (event) => {
  if (!el.approvalMenu || el.approvalMenu.classList.contains("hidden")) return;
  if (event.target instanceof Element && event.target.closest("#approval-menu, #btn-approval")) return;
  setApprovalMenu(false);
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
// The badge answers "how deep can this model think" before picking it. Claude
// and gateway rows declare the exact levels per model, so those show the real
// span and nothing at all when the model offers no levels, which keeps Haiku
// from claiming the same depth as Opus. Pi rows fall back to
// getSupportedThinkingLevels: levels through "high" are standard, while
// "xhigh"/"max" require a non-null thinkingLevelMap entry.
function modelThinkingBadge(model) {
  const declaredLevels = Array.isArray(model?.supportedEffortLevels) ? model.supportedEffortLevels : null;
  if (declaredLevels) {
    const levels = [...new Set(declaredLevels
      .map(level => String(level).trim().toLowerCase())
      .filter(level => THINKING_LEVEL_ORDER.includes(level)))]
      .sort((a, b) => THINKING_LEVEL_ORDER.indexOf(a) - THINKING_LEVEL_ORDER.indexOf(b));
    if (!levels.length) return "";
    return levels.length === 1 ? levels[0] : `${levels[0]}-${levels[levels.length - 1]}`;
  }
  if (!model?.reasoning) return "";
  const map = model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? model.thinkingLevelMap : null;
  if (map?.max) return "max";
  if (map?.xhigh) return "xhigh";
  return "high";
}

function normalizeOpenCodeModel(model) {
  return openCodeContext.normalizeModel(model);
}

function normalizeCodexModel(model) {
  if (typeof model === "string") {
    const id = model.trim();
    return id ? { id, name: id, provider: "codex", contextWindow: null, reasoning: true } : null;
  }
  if (!model || typeof model !== "object") return null;
  // Official Codex Model objects carry the wire id in `model`; `id` can be a
  // catalog row identifier and must not be sent back as the next-turn model.
  const id = String(model.model || model.id || model.slug || model.name || "").trim();
  if (!id) return null;
  const limit = model.limit && typeof model.limit === "object" ? model.limit : {};
  const reasoningEffortsDeclared = Array.isArray(model.supportedReasoningEfforts) || Array.isArray(model.reasoningEfforts);
  const supportedEfforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.map((item) => String(item?.reasoningEffort || item?.value || item?.name || item || "").trim()).filter(Boolean)
    : Array.isArray(model.reasoningEfforts)
      ? model.reasoningEfforts.map((item) => String(item?.reasoningEffort || item?.value || item?.name || item || "").trim()).filter(Boolean)
      : [];
  return {
    ...model,
    id,
    provider: "codex",
    name: String(model.name || model.displayName || model.title || id),
    description: String(model.description || ""),
    reasoning: model.reasoning === true || model.supportsReasoning === true
      || model.reasoningOutputTokens === true || supportedEfforts.length > 0,
    supportedReasoningEfforts: supportedEfforts,
    reasoningEffortsDeclared,
    thinkingLevelMap: Object.fromEntries(supportedEfforts.map((effort) => [effort, true])),
    defaultReasoningEffort: String(model.defaultReasoningEffort || "").trim() || null,
    contextWindow: positiveFinite(model.contextWindow ?? model.context_window ?? limit.context),
  };
}

function normalizeClaudeModel(model) {
  if (typeof model === "string") {
    const id = model.trim();
    return id ? { id, name: id, provider: "claude-code", contextWindow: null, reasoning: false } : null;
  }
  if (!model || typeof model !== "object") return null;
  const id = String(model.id || model.model || model.slug || model.name || "").trim();
  if (!id) return null;
  const supportedEffortLevels = Array.isArray(model.supportedEffortLevels)
    ? model.supportedEffortLevels.map(value => String(value).trim().toLowerCase()).filter(value => ["low", "medium", "high", "xhigh", "max"].includes(value))
    : [];
  return {
    ...model,
    id,
    provider: "claude-code",
    name: String(model.name || model.displayName || id),
    description: String(model.description || ""),
    reasoning: model.reasoning === true || model.supportsReasoning === true || model.supportsEffort === true || supportedEffortLevels.length > 0,
    supportsEffort: model.supportsEffort === true || supportedEffortLevels.length > 0,
    supportedEffortLevels: [...new Set(supportedEffortLevels)],
    supportsAutoMode: model.supportsAutoMode === true,
    defaultEffort: String(model.defaultEffort || model.default_effort || "").trim().toLowerCase() || null,
    contextWindow: positiveFinite(model.contextWindow ?? model.context_window),
  };
}

// Native Claude controls acknowledge a model switch with only its wire id.
// Reattach the already-fetched catalog row so gateway aliases keep their
// context capacity and reasoning metadata immediately after switching.
function claudeModelFromCatalog(models, value) {
  const normalized = normalizeClaudeModel(value);
  if (!normalized) return null;
  const row = Array.isArray(models) ? models.find(candidate => candidate?.id === normalized.id) : null;
  return row || normalized;
}

function currentOpenCodeModelPayload(model = rpc?.openCodeModel) {
  const normalized = normalizeOpenCodeModel(model);
  if (!normalized) return null;
  return { providerID: normalized.providerID, modelID: normalized.modelID };
}

function applyOpenCodeModel(model) {
  if (!rpc?.nativeOpenCode) return null;
  const normalized = openCodeContext.mergeModel(rpc.openCodeModel, model);
  if (!normalized) return null;
  const changed = openCodeContext.modelIdentity(normalized) !== openCodeContext.modelIdentity(rpc.openCodeModel);
  rpc.openCodeModel = normalized;
  composerModelContextWindow = positiveFinite(normalized.contextWindow);
  if (changed) {
    contextStats = null;
    contextStatsState = "awaiting";
  }
  updateComposerSummary(normalized.name || `${normalized.providerID}/${normalized.modelID}`, undefined);
  renderContextDashboard();
  return normalized;
}

// The provider catalog is scoped to the current project. Hydrate on open,
// not only when the model picker is opened; one request per connection and a
// bounded refresh interval avoid adding a provider lookup to every poll.
function syncOpenCodeModelCatalog(connection = rpc, { force = false } = {}) {
  if (!connection?.nativeOpenCode || rpc !== connection) return Promise.resolve(null);
  if (connection.openCodeModelsRequest) return connection.openCodeModelsRequest;
  const now = Date.now();
  if (!force && connection.openCodeModelsLoadedAt && now - connection.openCodeModelsLoadedAt < 60_000) {
    return Promise.resolve(connection.openCodeModels);
  }
  const generation = viewGeneration;
  const base = apiBase;
  const cwd = connection.nativeOpenCodeReadOnly ? "" : (connection.cwd || "");
  const isCurrent = () => rpc === connection && generation === viewGeneration && base === apiBase && cwd === (connection.cwd || "");
  const directory = cwd ? `?directory=${encodeURIComponent(cwd)}` : "";
  connection.openCodeModelsLoadedAt = now;
  const request = api(`/api/opencode/models${directory}`).then(result => {
    if (!isCurrent()) return null;
    connection.openCodeModels = (Array.isArray(result?.models) ? result.models : []).map(normalizeOpenCodeModel).filter(Boolean);
    const currentId = openCodeContext.modelIdentity(connection.openCodeModel);
    const known = connection.openCodeModels.find(model => openCodeContext.modelIdentity(model) === currentId);
    if (known) applyOpenCodeModel(known);
    if (connection.openCodeContextSnapshot && !connection.connectionLost) applyOpenCodeContextStats(connection.openCodeContextSnapshot, connection);
    return connection.openCodeModels;
  }).catch(() => null).finally(() => {
    if (connection.openCodeModelsRequest === request) connection.openCodeModelsRequest = null;
  });
  connection.openCodeModelsRequest = request;
  return request;
}

// ACP advertises model choice among its session config options. Pick the one
// the agent marked as the model selector, tolerating agents that only set a
// recognizable id.
function acpModelOption(configOptions) {
  const options = Array.isArray(configOptions) ? configOptions : [];
  return options.find((option) => option?.category === "model" && option.options?.length)
    || options.find((option) => /model/i.test(option?.id || "") && option.options?.length)
    || null;
}

async function openModelSheet({ preserveSearch = false } = {}) {
  const connection = rpc;
  const expectedSid = connection?.sid;
  const expectedGeneration = viewGeneration;
  const expectedBase = apiBase;
  if (!expectedSid) { toast("對話未開啟"); return; }
  el.modelSheet.classList.remove("hidden");
  if (el.modelSearch && !preserveSearch) { el.modelSearch.value = ""; }
  const stillCurrent = () => rpc === connection && rpc?.sid === expectedSid
    && viewGeneration === expectedGeneration && apiBase === expectedBase;
  // Re-use a cached list for this session. Keeping the previous rows in place
  // avoids a blank sheet/reflow while a host adapter refreshes its catalog.
  if (!availableModels.length) {
    el.modelList.innerHTML = '<p style="padding:12px 4px;color:var(--pine-soft);font-size:13.5px">讀取中…</p>';
  }
  const setUnavailable = (message) => {
    if (!stillCurrent()) return;
    el.modelList.innerHTML = "";
    const empty = document.createElement("p");
    empty.style.cssText = "padding:12px 4px;color:var(--pine-soft);font-size:13.5px";
    empty.textContent = message;
    el.modelList.appendChild(empty);
  };
  try {
    if (connection?.nativeCodexMutation) {
      await retryCodexNativeTransient(async () => {
        if (Array.isArray(connection.codexModels) && connection.codexModelsLoaded) {
          availableModels = connection.codexModels;
          renderModelList(connection.codexModel?.id || null, "codex");
        }
        let cursor = null;
        const rows = [];
        for (let page = 0; page < 32; page += 1) {
          if (!stillCurrent()) return;
          const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
          const result = await api(`/api/codex/models${query}`);
          if (!stillCurrent()) return;
          const data = Array.isArray(result?.data) ? result.data : [];
          rows.push(...data);
          const next = typeof result?.nextCursor === "string" && result.nextCursor.length ? result.nextCursor : null;
          if (!next || next === cursor) break;
          cursor = next;
        }
        availableModels = rows.map(normalizeCodexModel).filter(Boolean);
        connection.codexModels = availableModels;
        connection.codexModelsLoaded = true;
        const observed = availableModels.find(model => model.id === connection.codexModel?.id);
        if (observed && !connection.codexModelSelected) connection.codexModel = observed;
        syncNativeThinkingSelect(connection);
        renderModelList(connection.codexModel?.id || null, "codex");
      });
      return;
    }
    if (connection?.nativeClaudeStructured) {
      if (Array.isArray(connection.claudeModels) && connection.claudeModelsLoaded) {
        availableModels = connection.claudeModels;
        renderModelList(connection.claudeModel?.id || null, "claude-code");
      }
      const result = await api(`/api/claude/structured/models?sessionId=${encodeURIComponent(connection.nativeSessionId)}`);
      if (!stillCurrent()) return;
      availableModels = (Array.isArray(result?.models) ? result.models : []).map(normalizeClaudeModel).filter(Boolean);
      connection.claudeModels = availableModels;
      connection.claudeModelsLoaded = true;
      if (!connection.claudeModelSelected) {
        const current = claudeModelFromCatalog(availableModels, result?.currentModel)
          || availableModels.find(model => model.id === "default")
          || availableModels[0];
        if (current) {
          connection.claudeModel = current;
          composerModelContextWindow = positiveFinite(current.contextWindow);
          updateComposerSummary(current.name || current.id, undefined);
        }
      }
      connection.claudeEffort = String(result?.currentEffort || connection.claudeEffort || "auto").toLowerCase();
      syncNativeThinkingSelect(connection);
      const current = connection.claudeModel || normalizeClaudeModel(result?.currentModel);
      renderModelList(current?.id || null, "claude-code");
      return;
    }
    if (connection?.nativeOpenCode) {
      const models = await syncOpenCodeModelCatalog(connection, { force: true });
      if (!stillCurrent()) return;
      availableModels = models || connection.openCodeModels || [];
      renderModelList(connection.openCodeModel?.modelID || null, connection.openCodeModel?.providerID || null);
      return;
    }
    if (connection?.nativeAcp) {
      // ACP agents advertise model choice as a session config option; the
      // option whose category is "model" is the one this sheet edits.
      const result = await api(`/api/${connection.acpAgentId}/acp/config?sessionId=${encodeURIComponent(connection.nativeSessionId)}`);
      if (!stillCurrent()) return;
      const option = acpModelOption(result?.configOptions);
      if (!option) {
        availableModels = [];
        setUnavailable(tKey("runtime.modelChoiceUnavailable"));
        return;
      }
      connection.acpModelConfigId = option.id;
      availableModels = option.options.map((choice) => ({
        id: choice.value, name: choice.name || choice.value, provider: connection.acpAgentId,
        description: choice.description || "",
      }));
      renderModelList(option.currentValue, connection.acpAgentId);
      return;
    }
    const [modelsRes, stateRes] = await Promise.allSettled([
      api(`/api/models?sid=${encodeURIComponent(expectedSid)}`),
      rpcCmd(expectedSid, { type: "get_state" }),
    ]);
    if (!stillCurrent()) return;
    if (modelsRes.status === "rejected") throw modelsRes.reason;
    availableModels = modelsRes.value?.models || [];
    if (modelsRes.value?.catalog?.errors?.length) toast(tKey("modelsCheck.failed", { count: modelsRes.value.catalog.errors.length }));
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
    if (stillCurrent()) {
      if (availableModels.length) {
        renderModelList(connection?.codexModel?.id || connection?.claudeModel?.id || modelSheetCurrentId,
          connection?.nativeCodexMutation ? "codex" : connection?.nativeClaudeStructured ? "claude-code" : modelSheetCurrentProvider);
      } else {
        el.modelList.innerHTML = "";
        const error = document.createElement("p");
        error.className = "model-load-error";
        error.textContent = tKey("runtime.loadFailed", { detail: e.message || "unknown error" });
        el.modelList.appendChild(error);
      }
    }
  }
}

function renderModelList(currentId, currentProvider = null) {
  const connection = rpc;
  const expectedSid = connection?.sid;
  const expectedGeneration = viewGeneration;
  const expectedBase = apiBase;
  const stillCurrent = () => rpc === connection && rpc?.sid === expectedSid
    && viewGeneration === expectedGeneration && apiBase === expectedBase;
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
  const visibleModels = availableModels.filter((m) => m?.hidden !== true).filter(isModelVisible).filter((m) => !query
    || `${m.name || ""} ${m.id || ""} ${m.provider || ""}`.toLocaleLowerCase().includes(query));
  if (current) updateComposerSummary(current.name || current.id, undefined);
  else if (!currentId && !connection?.nativeCodexMutation && !connection?.nativeClaudeStructured) {
    updateComposerSummary("", undefined);
  }
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
    row.querySelector("strong").dataset.i18nIgnore = "true";
    row.querySelector("small").textContent = (m.provider || "?") + (m.contextWindow ? " · " + Math.round(m.contextWindow/1000) + "k ctx" : "");
    const badge = row.querySelector(".model-thinking-badge");
    const badgeText = modelThinkingBadge(m);
    badge.textContent = badgeText;
    badge.classList.toggle("hidden", !badgeText);
    if (m.description) row.title = m.description;
    row.addEventListener("click", async () => {
      if (!expectedSid) return;
      try {
        if (!stillCurrent()) return;
        if (connection?.nativeCodexMutation) {
          const model = normalizeCodexModel(m);
          if (!model) throw new Error("Invalid Codex model");
          connection.codexModel = model;
          connection.codexModelSelected = true;
          // Codex selection applies to the next prompt. Keep the gauge tied to
          // the adapter's current/last context response instead of showing the
          // newly selected model's capacity before native readback changes.
          composerModelContextWindow = null;
          syncNativeThinkingSelect(connection);
          updateComposerSummary(model.name || model.id, undefined);
          renderContextDashboard();
          toast("模型：" + (model.name || model.id));
          renderModelList(model.id, "codex");
          return;
        }
        if (connection?.nativeClaudeStructured) {
          const model = normalizeClaudeModel(m);
          if (!model) throw new Error("Invalid Claude model");
          const result = await post("/api/claude/structured/model", {
            sessionId: connection.nativeSessionId,
            model: model.id,
          });
          if (!stillCurrent()) return;
          if (result?.accepted === false || result?.kind === "reject" || result?.success === false) {
            throw new Error(result.error || result.code || "Claude rejected the model switch");
          }
          const selected = claudeModelFromCatalog(connection.claudeModels, result?.model) || model;
          connection.claudeModel = selected;
          connection.claudeModelSelected = true;
          // A model ACK invalidates the previous model's context capacity. The
          // follow-up adapter readback owns the new value (which may remain
          // unknown). Keep a catalog capacity when it is available, while
          // leaving current usage/percentage unknown until native readback.
          resetContextDashboard();
          composerModelContextWindow = positiveFinite(selected.contextWindow);
          updateComposerSummary(selected.name || selected.id, undefined);
          syncNativeThinkingSelect(connection);
          void syncNativeContext(connection);
          toast("模型：" + (selected.name || selected.id));
          renderModelList(selected.id, "claude-code");
          return;
        }
        if (connection?.nativeOpenCode) {
          const model = normalizeOpenCodeModel(m);
          const result = await post("/api/opencode/model", {
            sessionId: connection.nativeSessionId,
            cwd: connection.cwd,
            model: currentOpenCodeModelPayload(model),
          });
          if (!stillCurrent()) return;
          if (result?.accepted === false) throw new Error(result.error || "OpenCode rejected the model switch");
          const selected = applyOpenCodeModel(model);
          connection.openCodeModelSelected = true;
          toast("模型：" + (selected?.name || selected?.modelID || m.id));
          renderModelList(selected?.modelID || m.id, selected?.providerID || m.provider);
          return;
        }
        if (connection?.nativeAcp) {
          const result = await post(`/api/${connection.acpAgentId}/acp/config`, {
            sessionId: connection.nativeSessionId,
            configId: connection.acpModelConfigId,
            value: m.id,
          });
          if (!stillCurrent()) return;
          if (result?.kind === "reject") throw new Error(result.code || "model switch rejected");
          const option = acpModelOption(result?.configOptions);
          updateComposerSummary(m.name || m.id, undefined);
          toast("模型：" + (m.name || m.id));
          renderModelList(option?.currentValue || m.id, connection.acpAgentId);
          return;
        }
        const result = await rpcCmd(expectedSid, { type: "set_model", provider: m.provider, modelId: m.id });
        if (!stillCurrent()) return;
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
  items.push({ kind: "action", tag: "⌘", label: window.stepsembleI18n?.t("Open Settings") || "Open Settings", run: () => { showSettings(); syncSettingsNav(); } });
  items.push({ kind: "action", tag: "⌘", label: settings.showTemporarySessions
    ? (window.stepsembleI18n?.t("Hide Sub Agent sessions") || "Hide Sub Agent sessions")
    : (window.stepsembleI18n?.t("Show Sub Agent sessions") || "Show Sub Agent sessions"),
    run: () => { settings = saveSettings({ showTemporarySessions: !settings.showTemporarySessions }); refreshSessions(); } });
  const sessions = [...sessionsCache]
    .sort((a, b) => (Number(b.mtimeMs) || 0) - (Number(a.mtimeMs) || 0))
    .slice(0, 30);
  for (const s of sessions) {
    const name = sessionDisplayTitle(s).slice(0, 70);
    items.push({ kind: "session", label: name, run: () => openExisting(s) });
  }
  // A pane belongs to one computer, so it offers no computer switch.
  for (const m of WORKSPACE_PANE ? [] : machines) {
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
  // Each installed agent's own sign-in commands, for agents that cannot open
  // a conversation until they are signed in.
  void loadAgentAuthCatalog().then(catalog => {
    if (!catalog?.agents || !el.commandPalette || el.commandPalette.classList.contains("hidden")) return;
    const items = [];
    for (const [agentId, entry] of Object.entries(catalog.agents)) {
      if (!entry?.installed) continue;
      const label = agentTerminalLabel(agentId);
      items.push({ kind: "action", tag: "›", label: label + " · /login", run: () => void openAgentTerminal({ agentId, action: "login" }) });
      if (entry.status) items.push({ kind: "action", tag: "›", label: label + " · /status", run: () => void openAgentTerminal({ agentId, action: "status" }) });
    }
    commandItems = [...commandItems, ...items];
    renderCommandResults();
  }).catch(() => {});
  // Models come from the live RPC; append them once the catalog answers so
  // opening the palette stays instant.
  if (rpc?.sid && !rpc.generic) {
    const expectedSid = rpc.sid;
    try {
      const r = await api(`/api/models?sid=${encodeURIComponent(expectedSid)}`);
      if (rpc?.sid === expectedSid && Array.isArray(r?.models) && el.commandPalette && !el.commandPalette.classList.contains("hidden")) {
        const models = r.models.filter((m) => isModelVisible(m)).slice(0, 60);
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
function openSettingsSection(target, { root = false } = {}) {
  showSettings();
  showSettingsCategory(SETTINGS_TARGET_CATEGORIES[target] || null);
  syncSettingsNav({ root });
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
function refreshVisibleModelCatalogs() {
  if (document.hidden) return;
  if (el.modelSheet && !el.modelSheet.classList.contains("hidden") && rpc?.sid
    && (!rpc.generic || rpc.nativeCodexMutation || rpc.nativeClaudeStructured || rpc.nativeOpenCode)) {
    void openModelSheet({ preserveSearch: true });
  }
  if (el.viewModelSettings && !el.viewModelSettings.classList.contains("hidden") && currentModelSettingsAgent() === "pi") {
    void loadModelVisibility();
  }
}
setInterval(refreshVisibleModelCatalogs, 5 * 60 * 1000);
document.addEventListener("visibilitychange", refreshVisibleModelCatalogs);
el.modelClose.addEventListener("click", closeModelSheet);
el.modelSearch?.addEventListener("input", () => renderModelList(modelSheetCurrentId, modelSheetCurrentProvider));
el.modelSheet.addEventListener("click", (event) => {
  if (event.target === el.modelSheet) closeModelSheet();
});
async function changeThinkingLevel(level) {
  const expectedSid = rpc?.sid;
  if (!expectedSid) return;
  if (rpc?.nativeClaudeStructured) {
    const connection = rpc;
    const expectedGeneration = viewGeneration;
    const expectedBase = apiBase;
    const requested = String(level || "").toLowerCase();
    const allowed = new Set(["auto", "low", "medium", "high", "xhigh", "max"]);
    if (!allowed.has(requested) || ![...el.thinkingSelect.options].some(option => option.value === requested)) return;
    try {
      const result = await post("/api/claude/structured/effort", {
        sessionId: connection.nativeSessionId,
        effort: requested,
      });
      if (rpc !== connection || viewGeneration !== expectedGeneration || apiBase !== expectedBase) return;
      if (result?.kind === "reject" || result?.success === false) throw new Error(result.error || result.code || "Claude rejected the effort change");
      connection.claudeEffort = String(result?.effort || requested).toLowerCase();
      rememberThinkingPreference(connection.claudeEffort);
      syncNativeThinkingSelect(connection);
      updateComposerSummary(undefined, connection.claudeEffort);
      renderContextDashboard();
      toast(tKey("runtime.thinkingLevel", { level: connection.claudeEffort === "auto" ? "Default" : connection.claudeEffort }));
    } catch (error) {
      if (rpc === connection && viewGeneration === expectedGeneration && apiBase === expectedBase) {
        syncNativeThinkingSelect(connection);
        toast(tKey("runtime.saveFailed", { detail: error.message }), true);
      }
    }
    return;
  }
  if (rpc?.nativeCodexMutation) {
    const connection = rpc;
    const expectedGeneration = viewGeneration;
    const expectedBase = apiBase;
    const allowed = new Set([...CODEX_EFFORTS]);
    if (!allowed.has(String(level)) || ![...el.thinkingSelect.options].some(option => option.value === String(level))) return;
    connection.codexEffort = String(level);
    if (rpc === connection && viewGeneration === expectedGeneration && apiBase === expectedBase) {
      el.thinkingSelect.value = connection.codexEffort;
      updateComposerSummary(undefined, connection.codexEffort);
      renderContextDashboard();
    }
    return;
  }
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
  // Every agent gets its own /login, /logout and /status; Pi also lists the
  // commands its RPC reports.
  const terminalItems = agentTerminalSlashItems(conversationAgentId());
  const nativeItems = rpc && !rpc.generic ? availableCommands.filter(c => !AGENT_TERMINAL_ACTIONS.includes(String(c.name).toLowerCase())) : [];
  const commands = [...terminalItems, ...nativeItems];
  if (!m || !rpc || !commands.length) { el.slashMenu.classList.add("hidden"); slashState = null; return; }
  const q = m[1].toLowerCase();
  const items = commands.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8);
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
  if (c?.source === "terminal") {
    el.input.value = "";
    el.slashMenu.classList.add("hidden");
    slashState = null;
    el.input.dispatchEvent(new Event("input", { bubbles: true }));
    void openAgentTerminal({ agentId: conversationAgentId(), action: c.name });
    return;
  }
  el.input.value = "/" + c.name + " ";
  el.slashMenu.classList.add("hidden");
  slashState = null;
  el.input.dispatchEvent(new Event("input", { bubbles: true }));
  el.input.focus();
}

// ===========================================================================
// Conversation terminal: each agent's own /login, /logout and /status
// ===========================================================================
//
// Typing /login, /logout or /status in any conversation runs that agent's own
// command on the conversation's host, in a terminal, and shows it here the way
// a terminal would: sign-in links become buttons, one-time codes can be
// copied, and anything the command asks for is typed back into it. Pi has no
// sign-in command line, so its three commands use Pi's own sign-in runtime.

const agentTerminalApi = window.stepsembleAgentTerminal || null;
const AGENT_TERMINAL_ACTIONS = Object.freeze(["login", "logout", "status"]);
const AGENT_TERMINAL_DONE = new Set(["completed", "failed", "cancelled", "timed_out"]);
const HERMES_PROVIDER_SUGGESTIONS = Object.freeze(["openai-codex", "anthropic", "nous", "openrouter", "xai-oauth", "minimax", "opencode-go", "gemini", "deepseek", "zai"]);
let agentTerminal = null;
let agentTerminalSequence = 0;
let agentAuthCatalogState = { base: null, at: 0, data: null, request: null };

function agentTerminalText(key, vars = {}) { return tKey("agentTerminal." + key, vars); }

// The agent behind a conversation, whatever transport the conversation uses.
function conversationAgentId(connection = rpc) {
  if (!connection) return null;
  if (!connection.generic) return "pi";
  if (connection.nativeCodex) return "codex";
  if (connection.nativeOpenCode) return "opencode";
  if (connection.nativeGrokAcp) return "grok-build";
  if (connection.nativeAcp) return connection.acpAgentId || null;
  if (connection.nativeClaudeStructured) return "claude-code";
  if (connection.nativeAntigravityStructured) return "antigravity";
  return connection.agentId || connection.nativeHistoryProvider || null;
}

function agentTerminalSlashItems(agentId) {
  if (!agentId || !agentTerminalApi) return [];
  return AGENT_TERMINAL_ACTIONS.map(action => ({ name: action, description: agentTerminalText("slash." + action), source: "terminal" }));
}

async function loadAgentAuthCatalog(force = false) {
  const base = apiBase, state = agentAuthCatalogState;
  if (!force && state.base === base && state.data && Date.now() - state.at < 60000) return state.data;
  if (!force && state.base === base && state.request) return state.request;
  const request = api("/api/agent-auth/catalog").then(data => {
    if (agentAuthCatalogState.request === request) agentAuthCatalogState = { base, at: Date.now(), data, request: null };
    return data;
  }, error => {
    if (agentAuthCatalogState.request === request) agentAuthCatalogState = { ...agentAuthCatalogState, request: null };
    throw error;
  });
  agentAuthCatalogState = { base, at: state.base === base ? state.at : 0, data: state.base === base ? state.data : null, request };
  return request;
}

function agentTerminalHostName(base = apiBase) {
  const id = base ? base.replace(/^\/r\//, "") : (selfId || selectedId);
  return machineName(id) || id || "";
}

function agentTerminalLabel(agentId) {
  // Settings opened on its own page has no connector catalog loaded yet.
  const names = { pi: "Pi Agent", codex: "Codex", "claude-code": "Claude Code", opencode: "OpenCode", kilo: "Kilo Code",
    hermes: "Hermes", "grok-build": "Grok Build", cline: "Cline", antigravity: "Antigravity" };
  const label = agentConnectorLabel(agentId);
  return label && label !== agentId ? label : names[agentId] || label;
}

// Columns that fit the sheet, so sign-in commands wrap where the screen does.
// The screen stays hidden until there is output, so it is shown for the
// moment it takes to measure; the class comes back before the next paint.
function agentTerminalSize() {
  const screen = el.agentTerminalScreen;
  let charWidth = 7.2, width = 340;
  if (screen) {
    const hidden = screen.classList.contains("hidden");
    if (hidden) screen.classList.remove("hidden");
    const probe = document.createElement("span");
    probe.textContent = "0000000000";
    probe.style.visibility = "hidden";
    probe.style.position = "absolute";
    screen.appendChild(probe);
    charWidth = probe.getBoundingClientRect().width / 10 || charWidth;
    probe.remove();
    const style = getComputedStyle(screen);
    const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    if (screen.clientWidth) width = screen.clientWidth - padding;
    if (hidden) screen.classList.add("hidden");
  }
  return { cols: Math.max(40, Math.min(140, Math.floor(width / charWidth))), rows: 24 };
}

function agentTerminalWrite(term, text) {
  if (!term?.screen || !text) return;
  term.screen.write(text);
  term.raw = (term.raw + text).slice(-65536);
  term.links = agentTerminalApi.extractLinks(term.raw, term.screen.links);
  term.codes = agentTerminalApi.extractCodes(term.raw);
  // A prompt for a key, token or password hides what is typed next. It only
  // switches on as the prompt appears, so showing the entry again sticks.
  if (term.mode === "pty" && !term.done && term.action !== "status") {
    const secretPrompt = agentTerminalApi.looksSecretPrompt(term.screen.textRows({ includeHistory: false }));
    if (secretPrompt && !term.secretPrompt) term.secret = true;
    term.secretPrompt = secretPrompt;
  }
  scheduleAgentTerminalRender(term);
}

function agentTerminalLine(term, text, tone = "") {
  const color = tone === "dim" ? "\x1b[2m" : tone === "ok" ? "\x1b[32m" : tone === "error" ? "\x1b[31m" : tone === "warn" ? "\x1b[33m" : "";
  agentTerminalWrite(term, (color ? color + text + "\x1b[0m" : text) + "\r\n");
}

function newAgentTerminalScreen(term) {
  const size = agentTerminalSize();
  term.cols = size.cols; term.rows = size.rows;
  term.screen = agentTerminalApi.createScreen({ cols: size.cols, rows: size.rows, scrollback: 600 });
  term.raw = ""; term.links = []; term.codes = [];
}

async function openAgentTerminal({ agentId, action = "login", argument = "" } = {}) {
  if (!agentTerminalApi || !el.agentTerminal || !agentId || !AGENT_TERMINAL_ACTIONS.includes(action)) return;
  closeAgentTerminal({ silent: true });
  const term = {
    id: ++agentTerminalSequence, agentId, action, argument: String(argument || "").trim(), hostBase: apiBase,
    phase: "preparing", controls: [], notes: [], runId: null, es: null, lastEventId: -1, reconnectTimer: null, reconnectAttempt: 0,
    state: null, exitCode: null, done: false, secret: false, pi: null, legacyTimer: null, renderFrame: null, followOutput: true,
  };
  agentTerminal = term;
  el.agentTerminal.classList.remove("hidden");
  newAgentTerminalScreen(term);
  renderAgentTerminal();
  try { await prepareAgentTerminal(term); }
  catch (error) {
    if (agentTerminal !== term) return;
    agentTerminalLine(term, agentTerminalText("failed", { detail: error.message || "unknown error" }), "error");
    finishAgentTerminal(term, "failed");
  }
}

function closeAgentTerminal({ silent = false, detach = false } = {}) {
  const term = agentTerminal;
  if (!term) { el.agentTerminal?.classList.add("hidden"); return; }
  agentTerminal = null;
  if (term.reconnectTimer) clearTimeout(term.reconnectTimer);
  if (term.legacyTimer) clearTimeout(term.legacyTimer);
  if (term.renderFrame) cancelAnimationFrame(term.renderFrame);
  try { term.es?.close(); } catch {}
  // Closing stops the sign-in, except where it carries on without this sheet:
  // a detached terminal run (/login attaches to it again) and the older
  // host-browser Claude sign-in, which finishes on the host by itself.
  if (!term.done && term.hostBase === apiBase) {
    if (term.mode === "pi" && term.pi?.runId) void post("/api/provider-auth/cancel", { runId: term.pi.runId }).catch(() => {});
    else if (term.mode === "pty" && term.runId && !detach) void post("/api/agent-auth/cancel", { runId: term.runId }).catch(() => {});
  }
  el.agentTerminal?.classList.add("hidden");
  if (el.agentTerminalInput) { el.agentTerminalInput.value = ""; el.agentTerminalInput.type = "text"; }
  notifyWorkspaceSignIn(term, "closed");
  if (!silent) el.input?.focus({ preventScroll: true });
}

// A sign-in opened from the Workspace's New session reports back to it.
function notifyWorkspaceSignIn(term, state) {
  if (!WORKSPACE_PANE || term?.action !== "login" || PAGE_QUERY.get("signin") !== term.agentId) return;
  parent.postMessage({ type: "workspace-signin", agentId: term.agentId, state, completed: term.state === "completed" }, location.origin);
}

function requestCloseAgentTerminal() {
  const term = agentTerminal;
  if (term && !term.done && term.runId && term.mode !== "legacy" && term.action !== "status" && !window.confirm(agentTerminalText("stopConfirm"))) return;
  closeAgentTerminal();
}

function finishAgentTerminal(term, state, code = null) {
  if (!term || term.done) return;
  term.done = true; term.state = state; term.exitCode = Number.isInteger(code) ? code : null;
  term.phase = "done"; term.secret = false;
  try { term.es?.close(); } catch {}
  term.es = null;
  if (term.reconnectTimer) { clearTimeout(term.reconnectTimer); term.reconnectTimer = null; }
  if (term.legacyTimer) { clearTimeout(term.legacyTimer); term.legacyTimer = null; }
  if (state === "completed" && term.action !== "status") {
    // A new sign-in changes which models and limits the agent can use.
    agentAuthCatalogState = { base: null, at: 0, data: null, request: null };
    if (term.agentId === "pi") void loadModelVisibility(true, true);
  }
  renderAgentTerminal();
  notifyWorkspaceSignIn(term, state);
}

async function prepareAgentTerminal(term) {
  const label = agentTerminalLabel(term.agentId), host = agentTerminalHostName(term.hostBase);
  let catalog;
  try { catalog = await loadAgentAuthCatalog(true); }
  catch (error) {
    // A host on an earlier Stepsemble has no terminal routes yet.
    if (agentTerminal !== term || Number(error?.status) !== 404) throw error;
    agentTerminalLine(term, agentTerminalText("olderHost", { host }), "warn");
    finishAgentTerminal(term, "failed");
    return;
  }
  if (agentTerminal !== term) return;
  const entry = catalog?.agents?.[term.agentId];
  if (!entry || !entry.installed) {
    agentTerminalLine(term, agentTerminalText("notInstalled", { agent: label, host }), "warn");
    finishAgentTerminal(term, "failed");
    return;
  }
  if (entry.runtime === "pi") { term.mode = "pi"; await preparePiTerminal(term); return; }
  term.mode = "pty";
  if (term.agentId === "claude-code" && entry.desktop && !entry.terminal) { prepareLegacyClaudeTerminal(term); return; }
  if (term.action !== "status") {
    // Another device may already be running a sign-in for this agent.
    try {
      const active = await api("/api/agent-auth/active?agentId=" + encodeURIComponent(term.agentId));
      if (agentTerminal !== term) return;
      if (active?.run?.runId) {
        term.notes = [{ tone: "info", text: agentTerminalText("attached") }];
        attachAgentTerminalRun(term, active.run);
        return;
      }
    } catch {}
  }
  if (term.action === "status") {
    if (!entry.status) { agentTerminalLine(term, agentTerminalText("unsupported.status", { agent: label }), "warn"); finishAgentTerminal(term, "failed"); return; }
    await startAgentTerminalRun(term, { choice: "default" });
    return;
  }
  const choices = Array.isArray(entry[term.action]) ? entry[term.action] : [];
  if (!choices.length) {
    agentTerminalLine(term, agentTerminalText("unsupported." + term.action, { agent: label }), "warn");
    finishAgentTerminal(term, "failed");
    return;
  }
  term.phase = "choose";
  const notes = [];
  if (choices.every(choice => choice.replaces)) notes.push({ tone: "warn", text: agentTerminalText("replacesWarning", { agent: label }) });
  if (choices.some(choice => choice.inApp)) notes.push({ tone: "info", text: agentTerminalText("inAppHint", { agent: label, command: "/" + term.action }) });
  term.notes = notes;
  const needsProvider = choices.some(choice => choice.provider);
  const start = (choice, provider = "") => void startAgentTerminalRun(term, { choice: choice.id, provider });
  if (needsProvider) {
    term.controls = [{ type: "provider", choices, value: term.argument, suggestions: HERMES_PROVIDER_SUGGESTIONS, onSubmit: start }];
  } else if (term.action === "logout") {
    term.controls = [{ type: "button", primary: true, danger: true, label: agentTerminalText("logoutButton", { agent: label, host }), onClick: () => start(choices[0]) }];
  } else if (choices.length > 1) {
    term.controls = choices.map((choice, index) => ({ type: "button", primary: index === 0, label: agentTerminalChoiceLabel(term.agentId, choice.id, host),
      description: choice.hostBrowser ? agentTerminalText("hint.hostBrowser", { host }) : choice.secret ? agentTerminalText("hint.secret") : choice.id === "device" ? agentTerminalText("hint.device") : "",
      onClick: () => start(choice) }));
  } else if (choices[0].replaces) {
    term.controls = [{ type: "button", primary: true, label: agentTerminalText("startButton"), onClick: () => start(choices[0]) }];
  } else {
    await startAgentTerminalRun(term, { choice: choices[0].id });
    return;
  }
  renderAgentTerminal();
}

function agentTerminalChoiceLabel(agentId, choiceId, host) {
  const specific = "choice." + agentId + "." + choiceId;
  const translated = agentTerminalText(specific, { host });
  return translated && translated !== "agentTerminal." + specific ? translated : agentTerminalText("choice." + choiceId, { host });
}

async function startAgentTerminalRun(term, { choice, provider = "" } = {}) {
  if (agentTerminal !== term) return;
  term.phase = "running"; term.controls = []; term.state = "starting"; term.done = false; term.exitCode = null; term.secret = false; term.secretPrompt = false;
  renderAgentTerminal();
  let result;
  try {
    result = await post("/api/agent-auth/start", { agentId: term.agentId, action: term.action, choice, ...(provider ? { provider } : {}), cols: term.cols, rows: term.rows });
  } catch (error) {
    if (agentTerminal !== term) return;
    const label = agentTerminalLabel(term.agentId), host = agentTerminalHostName(term.hostBase);
    const code = String(error?.code || error?.message || "");
    if (code === "desktop_terminal_unavailable") { agentAuthCatalogState = { base: null, at: 0, data: null, request: null }; prepareLegacyClaudeTerminal(term); return; }
    if (code === "auth_run_active") {
      try {
        const active = await api("/api/agent-auth/active?agentId=" + encodeURIComponent(term.agentId));
        if (agentTerminal === term && active?.run?.runId) { term.notes = [{ tone: "info", text: agentTerminalText("attached") }]; attachAgentTerminalRun(term, active.run); return; }
      } catch {}
    }
    const known = { agent_busy: "busy", active_tasks: "busy", claude_login_active: "busy", agent_not_installed: "notInstalled", too_many_runs: "tooMany",
      desktop_unreachable: "desktopUnreachable", desktop_required: "desktopUnreachable", auth_run_active: "runActive" }[code];
    agentTerminalLine(term, known ? agentTerminalText(known, { agent: label, host }) : agentTerminalText("failed", { detail: error?.message || code || "unknown error" }), "error");
    finishAgentTerminal(term, "failed");
    return;
  }
  if (agentTerminal !== term) { if (result?.runId && !result.attached) void post("/api/agent-auth/cancel", { runId: result.runId }).catch(() => {}); return; }
  attachAgentTerminalRun(term, result);
}

function attachAgentTerminalRun(term, run) {
  term.runId = run.runId; term.command = run.command; term.state = run.state || "running"; term.phase = "running";
  term.done = false; term.lastEventId = -1; term.controls = [];
  agentTerminalLine(term, "$ " + (run.command || term.action), "dim");
  if (run.state === "awaiting_secret") term.secret = true;
  openAgentTerminalStream(term);
  renderAgentTerminal();
  if (term.secret) setTimeout(() => el.agentTerminalInput?.focus(), 0);
}

function openAgentTerminalStream(term) {
  if (agentTerminal !== term || !term.runId || term.done) return;
  const url = term.hostBase + "/api/agent-auth/stream?runId=" + encodeURIComponent(term.runId) + "&after=" + encodeURIComponent(term.lastEventId);
  const es = new EventSource(url);
  term.es = es;
  es.addEventListener("connected", event => {
    if (agentTerminal !== term) { es.close(); return; }
    term.reconnectAttempt = 0; term.reconnecting = false;
    let snapshot = null;
    try { snapshot = JSON.parse(event.data); } catch {}
    if (snapshot?.replayGap) agentTerminalLine(term, agentTerminalText("streamGap"), "dim");
    renderAgentTerminal();
  });
  es.onmessage = event => {
    if (agentTerminal !== term) { es.close(); return; }
    const id = Number(event.lastEventId);
    if (Number.isFinite(id)) term.lastEventId = Math.max(term.lastEventId, id);
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data?.type === "output" && typeof data.data === "string") agentTerminalWrite(term, data.data);
    else if (data?.type === "state") {
      term.state = data.state;
      if (AGENT_TERMINAL_DONE.has(data.state)) { finishAgentTerminal(term, data.state, data.code); return; }
      if (data.state === "awaiting_secret") { term.secret = true; setTimeout(() => el.agentTerminalInput?.focus(), 0); }
      renderAgentTerminal();
    }
  };
  es.onerror = () => {
    try { es.close(); } catch {}
    if (term.es === es) term.es = null;
    if (agentTerminal !== term || term.done) return;
    if (term.reconnectAttempt >= 6) {
      agentTerminalLine(term, agentTerminalText("lostConnection"), "error");
      finishAgentTerminal(term, "failed");
      return;
    }
    term.reconnecting = true;
    const delay = Math.min(8000, 500 * 2 ** term.reconnectAttempt++);
    term.reconnectTimer = setTimeout(() => { term.reconnectTimer = null; openAgentTerminalStream(term); }, delay);
    renderAgentTerminal();
  };
}

async function sendAgentTerminalInput(term, payload) {
  if (!term || term.done || term.hostBase !== apiBase) return false;
  try {
    if (term.mode === "pi") {
      const request = term.pi?.request;
      if (!request || !term.pi?.runId) return false;
      term.pi.request = null; term.controls = []; term.secret = false;
      renderAgentTerminal();
      await post("/api/provider-auth/respond", { runId: term.pi.runId, requestId: request.id, value: payload.data ?? "" });
      return true;
    }
    if (!term.runId) return false;
    await post("/api/agent-auth/input", { runId: term.runId, ...payload });
    return true;
  } catch (error) {
    if (agentTerminal === term) toast(agentTerminalText("inputFailed", { detail: error.message || "unknown error" }), true);
    return false;
  }
}

function submitAgentTerminalInput() {
  const term = agentTerminal, input = el.agentTerminalInput;
  if (!term || !input) return;
  const value = input.value;
  const secret = term.secret || input.type === "password";
  if (term.mode === "pi") {
    if (!term.pi?.request) return;
    input.value = "";
    agentTerminalLine(term, "> " + (secret ? "•".repeat(Math.min(value.length, 12)) : value), "dim");
    void sendAgentTerminalInput(term, { data: value });
    return;
  }
  input.value = "";
  if (term.state === "awaiting_secret") { if (value) void sendAgentTerminalInput(term, { data: value, secret: true }); return; }
  if (!value) { void sendAgentTerminalInput(term, { key: "enter" }); return; }
  void sendAgentTerminalInput(term, { data: value + "\r", ...(secret ? { secret: true } : {}) });
}

// Terminal keys typed straight into the focused screen, like a terminal.
const AGENT_TERMINAL_KEYMAP = Object.freeze({ ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", Enter: "enter", Tab: "tab", Escape: "escape", Backspace: "backspace" });
function handleAgentTerminalScreenKey(event) {
  const term = agentTerminal;
  if (!term || term.mode !== "pty" || term.done || !term.runId || event.isComposing) return;
  if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "c") { event.preventDefault(); void sendAgentTerminalInput(term, { key: "ctrl-c" }); return; }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const key = AGENT_TERMINAL_KEYMAP[event.key];
  if (key) { event.preventDefault(); if (key === "escape" && event.shiftKey) return; void sendAgentTerminalInput(term, { key }); return; }
  if (event.key.length === 1) { event.preventDefault(); void sendAgentTerminalInput(term, { data: event.key }); }
}

function scheduleAgentTerminalRender(term) {
  if (term.renderFrame) return;
  term.renderFrame = requestAnimationFrame(() => { term.renderFrame = null; if (agentTerminal === term) renderAgentTerminal(); });
}

function agentTerminalStatusText(term) {
  if (term.reconnecting) return agentTerminalText("reconnecting");
  if (term.phase === "preparing") return agentTerminalText("state.starting");
  if (term.phase === "choose") return term.action === "logout" ? agentTerminalText("confirmLogout") : agentTerminalText("chooseMethod");
  if (term.state === "completed") return agentTerminalText("state.completed");
  if (term.state === "failed") return Number.isInteger(term.exitCode) ? agentTerminalText("state.failedCode", { code: term.exitCode }) : agentTerminalText("state.failed");
  if (term.state && ["cancelled", "timed_out", "awaiting_secret", "starting", "running"].includes(term.state)) return agentTerminalText("state." + term.state);
  return "";
}

function renderAgentTerminalScreen(term) {
  const screen = el.agentTerminalScreen;
  if (!screen || !term.screen) return;
  const nearBottom = screen.scrollHeight - screen.scrollTop - screen.clientHeight < 24;
  const fragment = document.createDocumentFragment();
  for (const runs of term.screen.styledRows()) {
    const line = document.createElement("div");
    line.className = "agent-terminal-line";
    for (const run of runs) {
      const text = run.text.replace(/\s+$/, run === runs[runs.length - 1] ? "" : "$&");
      if (!text) continue;
      const attr = run.attr || {};
      if (!attr.fg && !attr.bg && !attr.bold && !attr.dim && !attr.inverse && !attr.underline && !attr.italic) { line.appendChild(document.createTextNode(text)); continue; }
      const span = document.createElement("span");
      span.textContent = text;
      const fg = attr.inverse ? (attr.bg || "var(--paper)") : attr.fg;
      const bg = attr.inverse ? (attr.fg || "var(--ink)") : attr.bg;
      if (fg) span.style.color = fg;
      if (bg) span.style.backgroundColor = bg;
      if (attr.bold) span.style.fontWeight = "700";
      if (attr.dim) span.style.opacity = "0.62";
      if (attr.italic) span.style.fontStyle = "italic";
      if (attr.underline) span.style.textDecoration = "underline";
      line.appendChild(span);
    }
    if (!line.childNodes.length) line.appendChild(document.createTextNode("\u00a0"));
    fragment.appendChild(line);
  }
  screen.replaceChildren(fragment);
  if (nearBottom || term.followOutput) { screen.scrollTop = screen.scrollHeight; term.followOutput = false; }
}

function renderAgentTerminalLinks(term) {
  const box = el.agentTerminalLinks;
  if (!box) return;
  box.replaceChildren();
  const links = (term.links || []).slice(-3).reverse(), codes = (term.codes || []).slice(-2).reverse();
  for (const code of codes) {
    const row = document.createElement("div");
    row.className = "agent-terminal-code";
    const label = document.createElement("span");
    label.textContent = agentTerminalText("code");
    const value = document.createElement("strong");
    value.textContent = code;
    value.dataset.i18nIgnore = "";
    const copy = document.createElement("button");
    copy.type = "button"; copy.className = "btn ghost agent-terminal-copy";
    copy.textContent = agentTerminalText("copy");
    copy.addEventListener("click", async () => { try { await copyText(code); toast(agentTerminalText("copied")); } catch {} });
    row.append(label, value, copy);
    box.appendChild(row);
  }
  links.forEach((link, index) => {
    let host = "";
    try { host = new URL(link).host; } catch {}
    const row = document.createElement("div");
    row.className = "agent-terminal-link";
    const open = document.createElement("a");
    open.className = "btn " + (index === 0 ? "primary" : "ghost") + " agent-terminal-open";
    open.href = link; open.target = "_blank"; open.rel = "noopener noreferrer";
    open.textContent = index === 0 ? agentTerminalText("openLink", { host }) : host;
    const copy = document.createElement("button");
    copy.type = "button"; copy.className = "btn ghost agent-terminal-copy";
    copy.textContent = agentTerminalText("copy");
    copy.addEventListener("click", async () => { try { await copyText(link); toast(agentTerminalText("copied")); } catch {} });
    row.append(open, copy);
    box.appendChild(row);
  });
  box.classList.toggle("hidden", !box.childNodes.length);
}

function renderAgentTerminalControls(term) {
  const box = el.agentTerminalChoices;
  if (!box) return;
  box.replaceChildren();
  for (const note of term.notes || []) {
    const p = document.createElement("p");
    p.className = "agent-terminal-note" + (note.tone === "warn" ? " is-warning" : "");
    p.textContent = note.text;
    box.appendChild(p);
  }
  for (const control of term.controls || []) {
    if (control.type === "button") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "agent-terminal-choice" + (control.primary ? " is-primary" : "") + (control.danger ? " is-danger" : "");
      const strong = document.createElement("strong");
      strong.textContent = control.label;
      button.appendChild(strong);
      if (control.description) { const small = document.createElement("small"); small.textContent = control.description; button.appendChild(small); }
      button.addEventListener("click", event => { if (event.detail < 2) control.onClick(); });
      box.appendChild(button);
    } else if (control.type === "provider") {
      const form = document.createElement("form");
      form.className = "agent-terminal-provider";
      const label = document.createElement("label");
      label.className = "field-label";
      label.textContent = agentTerminalText("providerLabel");
      const input = document.createElement("input");
      input.type = "text"; input.autocapitalize = "off"; input.spellcheck = false; input.autocomplete = "off";
      input.placeholder = agentTerminalText("providerPlaceholder");
      input.value = control.value || "";
      input.id = "agent-terminal-provider-input"; label.htmlFor = input.id;
      const listId = "agent-terminal-provider-list";
      const list = document.createElement("datalist");
      list.id = listId;
      for (const item of control.suggestions || []) { const option = document.createElement("option"); option.value = item; list.appendChild(option); }
      input.setAttribute("list", listId);
      form.append(label, input, list);
      const buttons = document.createElement("div");
      buttons.className = "agent-terminal-provider-actions";
      for (const choice of control.choices) {
        const button = document.createElement("button");
        button.type = "submit"; button.className = "btn " + (choice === control.choices[0] ? "primary" : "ghost");
        button.dataset.choice = choice.id;
        button.textContent = agentTerminal.action === "logout" ? agentTerminalText("logoutShort") : agentTerminalChoiceLabel(agentTerminal.agentId, choice.id, agentTerminalHostName(agentTerminal.hostBase));
        buttons.appendChild(button);
      }
      form.appendChild(buttons);
      form.addEventListener("submit", event => {
        event.preventDefault();
        const provider = input.value.trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(provider)) { input.focus(); input.setCustomValidity(agentTerminalText("providerInvalid")); input.reportValidity(); return; }
        input.setCustomValidity("");
        const choice = control.choices.find(item => item.id === event.submitter?.dataset.choice) || control.choices[0];
        control.onSubmit(choice, provider);
      });
      box.appendChild(form);
    } else if (control.type === "list") {
      const wrap = document.createElement("div");
      wrap.className = "agent-terminal-list";
      if (control.filter) {
        const filter = document.createElement("input");
        filter.type = "search"; filter.placeholder = control.filterPlaceholder || ""; filter.className = "agent-terminal-filter";
        filter.value = control.query || "";
        filter.setAttribute("aria-label", control.filterPlaceholder || "");
        filter.addEventListener("input", () => { control.query = filter.value; renderItems(); });
        wrap.appendChild(filter);
      }
      const items = document.createElement("div");
      items.className = "agent-terminal-list-items";
      const renderItems = () => {
        items.replaceChildren();
        const query = String(control.query || "").trim().toLocaleLowerCase();
        const matches = control.items.filter(item => !query || [item.label, item.id, item.description].some(value => String(value || "").toLocaleLowerCase().includes(query)));
        for (const item of matches) {
          const button = document.createElement("button");
          button.type = "button"; button.className = "agent-terminal-choice";
          const strong = document.createElement("strong"); strong.textContent = item.label; strong.dataset.i18nIgnore = "";
          button.appendChild(strong);
          if (item.description) { const small = document.createElement("small"); small.textContent = item.description; button.appendChild(small); }
          if (item.badge) { const badge = document.createElement("span"); badge.className = "agent-terminal-badge"; badge.textContent = item.badge; button.appendChild(badge); }
          button.addEventListener("click", event => { if (event.detail < 2) control.onPick(item); });
          items.appendChild(button);
        }
        if (!matches.length) { const empty = document.createElement("p"); empty.className = "agent-terminal-note"; empty.textContent = control.emptyText || ""; items.appendChild(empty); }
      };
      renderItems();
      wrap.appendChild(items);
      box.appendChild(wrap);
    }
  }
  box.classList.toggle("hidden", !box.childNodes.length);
}

function renderAgentTerminal() {
  const term = agentTerminal;
  if (!term || !el.agentTerminal) return;
  const label = agentTerminalLabel(term.agentId), host = agentTerminalHostName(term.hostBase);
  el.agentTerminalHost.textContent = agentTerminalText("eyebrow", { host });
  el.agentTerminalTitle.textContent = label + "  /" + term.action;
  renderAgentTerminalControls(term);
  // The screen appears once there is something to show, so choosing a
  // method or provider gets the whole sheet.
  el.agentTerminalScreen.classList.toggle("hidden", !term.raw);
  renderAgentTerminalScreen(term);
  renderAgentTerminalLinks(term);
  el.agentTerminalStatus.textContent = agentTerminalStatusText(term);
  el.agentTerminalStatus.dataset.state = term.done ? term.state || "" : term.phase;
  const running = !term.done && term.phase === "running";
  const piPrompt = term.mode === "pi" && !!term.pi?.request && term.pi.request.type !== "select";
  const acceptsInput = running && (term.mode === "pty" ? term.action !== "status" : piPrompt);
  el.agentTerminalForm.classList.toggle("hidden", !acceptsInput);
  el.agentTerminalKeys.classList.toggle("hidden", !(running && term.mode === "pty" && term.action !== "status" && term.state !== "awaiting_secret"));
  const hidden = term.secret || term.state === "awaiting_secret";
  el.agentTerminalInput.type = hidden ? "password" : "text";
  el.agentTerminalInput.placeholder = term.state === "awaiting_secret" ? agentTerminalText("secretPlaceholder") : piPrompt && term.pi.request.placeholder ? term.pi.request.placeholder : agentTerminalText("inputPlaceholder");
  el.agentTerminalSecret.setAttribute("aria-pressed", String(hidden));
  el.agentTerminalSecret.querySelector("use")?.setAttribute("href", hidden ? "#i-eye-off" : "#i-eye");
  el.agentTerminalSecret.classList.toggle("hidden", term.state === "awaiting_secret");
  el.agentTerminalStop.classList.toggle("hidden", !(running && term.action !== "status"));
  el.agentTerminalStatusButton.classList.toggle("hidden", !(term.done && term.action !== "status" && term.agentId));
}

// ---- Pi: the same three commands, through Pi's own sign-in runtime ----

async function preparePiTerminal(term) {
  const catalog = await api("/api/provider-catalog");
  if (agentTerminal !== term) return;
  const providers = Array.isArray(catalog?.providers) ? catalog.providers : [];
  const signedIn = providers.filter(provider => provider.configured);
  if (term.action === "status") {
    agentTerminalLine(term, "$ pi /status", "dim");
    if (!signedIn.length) agentTerminalLine(term, agentTerminalText("pi.none"));
    for (const provider of signedIn) agentTerminalLine(term, agentTerminalText("pi.statusLine", { name: provider.name, id: provider.id, type: provider.configuredType || "—" }));
    finishAgentTerminal(term, "completed");
    return;
  }
  const argument = term.argument.toLowerCase();
  const pick = provider => term.action === "logout" ? confirmPiLogout(term, provider) : choosePiLoginMethod(term, provider);
  const preset = argument ? providers.find(provider => provider.id.toLowerCase() === argument) : null;
  if (preset && (term.action === "login" || preset.configured)) { pick(preset); return; }
  const items = (term.action === "logout" ? signedIn : providers).map(provider => ({ id: provider.id, label: provider.name, description: provider.id,
    badge: provider.configured ? agentTerminalText("pi.signedIn") : "", provider }));
  if (!items.length) { agentTerminalLine(term, agentTerminalText(term.action === "logout" ? "pi.noSignedIn" : "pi.none")); finishAgentTerminal(term, "completed"); return; }
  term.phase = "choose";
  term.controls = [{ type: "list", filter: items.length > 8, filterPlaceholder: agentTerminalText("pi.search"), query: term.argument, items,
    emptyText: agentTerminalText("pi.noMatch"), onPick: item => pick(item.provider) }];
  term.notes = [{ tone: "info", text: agentTerminalText(term.action === "logout" ? "pi.chooseSignedIn" : "pi.chooseProvider") }];
  renderAgentTerminal();
}

function choosePiLoginMethod(term, provider) {
  const types = Array.isArray(provider.authTypes) ? provider.authTypes : [];
  if (types.length === 1) { void startPiLogin(term, provider, types[0]); return; }
  term.phase = "choose"; term.notes = [];
  term.controls = types.map((type, index) => ({ type: "button", primary: index === 0,
    label: agentTerminalText("pi.method." + type), description: type === "oauth" ? provider.oauthName || provider.name : provider.apiKeyName || "",
    onClick: () => void startPiLogin(term, provider, type) }));
  renderAgentTerminal();
}

async function startPiLogin(term, provider, authType) {
  if (agentTerminal !== term) return;
  term.phase = "running"; term.controls = []; term.notes = []; term.state = "running"; term.runId = "pi";
  agentTerminalLine(term, "$ pi /login " + provider.id, "dim");
  renderAgentTerminal();
  let result;
  try { result = await post("/api/provider-auth/start", { providerId: provider.id, authType }); }
  catch (error) {
    if (agentTerminal !== term) return;
    agentTerminalLine(term, agentTerminalText("failed", { detail: error.message || "unknown error" }), "error");
    finishAgentTerminal(term, "failed");
    return;
  }
  if (agentTerminal !== term) { void post("/api/provider-auth/cancel", { runId: result.runId }).catch(() => {}); return; }
  term.pi = { runId: result.runId, name: result.provider?.name || provider.name, request: null, lastEventId: -1 };
  openPiLoginStream(term);
}

function openPiLoginStream(term) {
  if (agentTerminal !== term || term.done || !term.pi?.runId) return;
  const es = new EventSource(term.hostBase + "/api/provider-auth/stream?runId=" + encodeURIComponent(term.pi.runId) + "&after=" + encodeURIComponent(term.pi.lastEventId));
  term.es = es;
  es.addEventListener("connected", () => { term.reconnectAttempt = 0; term.reconnecting = false; renderAgentTerminal(); });
  es.onmessage = event => {
    if (agentTerminal !== term) { es.close(); return; }
    const id = Number(event.lastEventId);
    if (Number.isFinite(id)) term.pi.lastEventId = Math.max(term.pi.lastEventId, id);
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    handlePiLoginEvent(term, data);
  };
  es.onerror = () => {
    try { es.close(); } catch {}
    if (term.es === es) term.es = null;
    if (agentTerminal !== term || term.done) return;
    if (term.reconnectAttempt >= 6) { agentTerminalLine(term, agentTerminalText("lostConnection"), "error"); finishAgentTerminal(term, "failed"); return; }
    term.reconnecting = true;
    const delay = Math.min(8000, 500 * 2 ** term.reconnectAttempt++);
    term.reconnectTimer = setTimeout(() => { term.reconnectTimer = null; openPiLoginStream(term); }, delay);
    renderAgentTerminal();
  };
}

function handlePiLoginEvent(term, data) {
  if (!data || typeof data !== "object") return;
  if (data.type === "notify") {
    const event = data.event || {};
    if (event.type === "auth_url") {
      if (event.instructions) agentTerminalLine(term, event.instructions);
      if (event.url) agentTerminalLine(term, event.url);
    } else if (event.type === "device_code") {
      if (event.verificationUrl) agentTerminalLine(term, agentTerminalText("pi.openLink", { url: event.verificationUrl }));
      if (event.userCode) agentTerminalLine(term, agentTerminalText("pi.enterCode", { code: event.userCode }));
    } else if (event.message) agentTerminalLine(term, event.message, "dim");
  } else if (data.type === "prompt") {
    const request = data.request || {};
    term.pi.request = request;
    if (request.message) agentTerminalLine(term, request.message);
    term.secret = request.type === "secret";
    term.controls = request.type === "select" ? (Array.isArray(request.options) ? request.options : []).map((option, index) => ({ type: "button", primary: index === 0,
      label: option.label || option.id, description: option.description || "",
      onClick: () => { agentTerminalLine(term, "> " + (option.label || option.id), "dim"); void sendAgentTerminalInput(term, { data: option.id }); } })) : [];
    renderAgentTerminal();
    if (request.type !== "select") setTimeout(() => el.agentTerminalInput?.focus(), 0);
  } else if (data.type === "success") {
    agentTerminalLine(term, agentTerminalText("pi.success", { name: data.providerName || term.pi?.name || "" }), "ok");
    finishAgentTerminal(term, "completed");
  } else if (data.type === "error") {
    agentTerminalLine(term, data.message || agentTerminalText("state.failed"), "error");
    finishAgentTerminal(term, "failed");
  } else if (data.type === "cancelled") {
    agentTerminalLine(term, agentTerminalText(data.reason === "timeout" ? "state.timed_out" : "state.cancelled"), "warn");
    finishAgentTerminal(term, data.reason === "timeout" ? "timed_out" : "cancelled");
  }
}

function confirmPiLogout(term, provider) {
  term.phase = "choose"; term.notes = [];
  term.controls = [{ type: "button", primary: true, danger: true, label: agentTerminalText("pi.logoutButton", { name: provider.name }),
    onClick: async () => {
      if (agentTerminal !== term) return;
      term.controls = []; term.phase = "running"; term.state = "running";
      agentTerminalLine(term, "$ pi /logout " + provider.id, "dim");
      renderAgentTerminal();
      try {
        await post("/api/provider-auth/delete", { providerId: provider.id });
        if (agentTerminal !== term) return;
        agentTerminalLine(term, agentTerminalText("pi.signedOut", { name: provider.name }), "ok");
        finishAgentTerminal(term, "completed");
      } catch (error) {
        if (agentTerminal !== term) return;
        agentTerminalLine(term, agentTerminalText("failed", { detail: error.message || "unknown error" }), "error");
        finishAgentTerminal(term, "failed");
      }
    } }];
  renderAgentTerminal();
}

// ---- Claude on a host whose desktop helper predates the terminal ----

function prepareLegacyClaudeTerminal(term) {
  const host = agentTerminalHostName(term.hostBase);
  term.mode = "legacy"; term.phase = "choose";
  term.notes = [{ tone: "warn", text: agentTerminalText("desktopHelperOld", { host }) }];
  term.controls = [{ type: "button", primary: true, label: agentTerminalText("updateHelper"), description: agentTerminalText("updateHelperHint"), onClick: () => void upgradeClaudeDesktopHelper(term) }];
  if (term.action === "login") term.controls.push({ type: "button", label: agentTerminalText("hostBrowserSignIn", { host }), onClick: () => void legacyClaudeSignIn(term) });
  if (term.action === "status") term.controls.push({ type: "button", label: agentTerminalText("checkStatus"), onClick: () => void legacyClaudeStatus(term) });
  renderAgentTerminal();
}

async function upgradeClaudeDesktopHelper(term) {
  term.controls = []; term.notes = []; term.phase = "running"; term.state = "running";
  agentTerminalLine(term, agentTerminalText("helperUpdating"), "dim");
  renderAgentTerminal();
  try {
    await post("/api/claude/desktop/upgrade", { confirm: true });
    if (agentTerminal !== term) return;
    agentTerminalLine(term, agentTerminalText("helperUpdated"), "ok");
    agentAuthCatalogState = { base: null, at: 0, data: null, request: null };
    term.mode = "pty"; term.state = null; term.phase = "preparing";
    await prepareAgentTerminal(term);
  } catch (error) {
    if (agentTerminal !== term) return;
    const code = String(error?.code || error?.message || "");
    agentTerminalLine(term, code === "active_tasks" ? agentTerminalText("busy", { agent: "Claude Code", host: agentTerminalHostName(term.hostBase) })
      : agentTerminalText("helperUpdateFailed", { detail: error?.message || code }), "error");
    finishAgentTerminal(term, "failed");
  }
}

async function legacyClaudeStatus(term) {
  term.controls = []; term.notes = []; term.phase = "running"; term.state = "running";
  renderAgentTerminal();
  try {
    const status = await api("/api/claude-auth/status");
    if (agentTerminal !== term) return;
    agentTerminalLine(term, agentTerminalText("legacyState." + (status?.credential?.state || "unknown")));
    finishAgentTerminal(term, "completed");
  } catch (error) {
    if (agentTerminal !== term) return;
    agentTerminalLine(term, agentTerminalText("failed", { detail: error.message || "unknown error" }), "error");
    finishAgentTerminal(term, "failed");
  }
}

async function legacyClaudeSignIn(term) {
  const host = agentTerminalHostName(term.hostBase);
  term.controls = []; term.notes = []; term.phase = "running"; term.state = "running";
  renderAgentTerminal();
  try {
    let status = await post("/api/claude-auth/prepare", { confirm: true });
    if (status?.login?.state === "prepared") status = await post("/api/claude-auth/start", { id: status.login.id });
    if (agentTerminal !== term) return;
    term.runId = "legacy"; term.legacyLogin = status?.login?.id || null;
    agentTerminalLine(term, agentTerminalText("legacyWaiting", { host }));
    const poll = async () => {
      term.legacyTimer = null;
      if (agentTerminal !== term || term.done) return;
      try {
        const current = await api("/api/claude-auth/status");
        if (agentTerminal !== term) return;
        const state = current?.login?.state;
        if (["completed", "failed", "cancelled", "timed_out", "unconfirmed", "blocked", "expired", "interrupted"].includes(state)) {
          agentTerminalLine(term, agentTerminalText("legacyLogin." + state), state === "completed" ? "ok" : "warn");
          finishAgentTerminal(term, state === "completed" ? "completed" : state === "cancelled" ? "cancelled" : "failed");
          return;
        }
      } catch {}
      term.legacyTimer = setTimeout(poll, 2000);
    };
    term.legacyTimer = setTimeout(poll, 2000);
  } catch (error) {
    if (agentTerminal !== term) return;
    agentTerminalLine(term, agentTerminalText("failed", { detail: error.message || "unknown error" }), "error");
    finishAgentTerminal(term, "failed");
  }
}

async function stopAgentTerminal() {
  const term = agentTerminal;
  if (!term || term.done) return;
  if (term.mode === "pi" && term.pi?.runId) { try { await post("/api/provider-auth/cancel", { runId: term.pi.runId }); } catch {} return; }
  if (term.mode === "legacy" && term.legacyLogin) { try { await post("/api/claude-auth/cancel", { id: term.legacyLogin }); } catch {} return; }
  if (term.runId && term.mode === "pty") { try { await post("/api/agent-auth/cancel", { runId: term.runId }); } catch {} }
}

el.agentTerminalClose?.addEventListener("click", requestCloseAgentTerminal);
el.agentTerminalDone?.addEventListener("click", requestCloseAgentTerminal);
el.agentTerminalStop?.addEventListener("click", () => void stopAgentTerminal());
el.agentTerminalStatusButton?.addEventListener("click", () => { const term = agentTerminal; if (term) void openAgentTerminal({ agentId: term.agentId, action: "status" }); });
el.agentTerminalForm?.addEventListener("submit", event => { event.preventDefault(); submitAgentTerminalInput(); });
el.agentTerminalSecret?.addEventListener("click", () => {
  const term = agentTerminal;
  if (!term) return;
  term.secret = !term.secret;
  renderAgentTerminal();
  el.agentTerminalInput?.focus();
});
el.agentTerminalKeys?.addEventListener("click", event => {
  const button = event.target.closest?.("[data-terminal-key]");
  const term = agentTerminal;
  if (!button || !term) return;
  void sendAgentTerminalInput(term, { key: button.dataset.terminalKey });
});
el.agentTerminalScreen?.addEventListener("keydown", handleAgentTerminalScreenKey);
el.agentTerminalScreen?.addEventListener("paste", event => {
  const term = agentTerminal, value = event.clipboardData?.getData("text") || "";
  if (!term || term.mode !== "pty" || term.done || !value) return;
  event.preventDefault();
  void sendAgentTerminalInput(term, { data: value.slice(0, 8000) });
});

// Offers the agent's own sign-in when a conversation could not start
// because the agent is signed out.
function agentSignInError(error) {
  const code = String(error?.code || ""), message = String(error?.message || "");
  return /sign_in_required|auth_required|login_required|not_signed_in|unauthenticated/.test(code)
    || /\b(?:sign in|signed in|log in|logged in|login|authenticat|unauthori[sz]ed|credential)/i.test(message);
}

// ---- Settings → Quota sources ----

let quotaSourcesState = { base: null, data: null, loading: false, error: null, at: 0 };

async function loadQuotaSources(force = false) {
  const base = apiBase;
  if (quotaSourcesState.loading && quotaSourcesState.base === base) return;
  if (!force && quotaSourcesState.base === base && quotaSourcesState.data && Date.now() - quotaSourcesState.at < 30000) { renderQuotaSources(); return; }
  quotaSourcesState = { ...quotaSourcesState, base, loading: true, error: null, ...(quotaSourcesState.base === base ? {} : { data: null }) };
  renderQuotaSources();
  try {
    const data = await api("/api/quota-sources");
    if (apiBase !== base) return;
    quotaSourcesState = { base, data, loading: false, error: null, at: Date.now() };
  } catch (error) {
    if (apiBase !== base) return;
    quotaSourcesState = { base, data: null, loading: false, error: error?.status === 404 ? "old" : error?.message || "unavailable", at: Date.now() };
  }
  renderQuotaSources();
}

function quotaWindowLabel(window) {
  if (window.key === "custom") return window.label || "";
  if (window.key && !["primary", "secondary", "tertiary"].includes(window.key)) return tKey("quotaSources.window." + window.key);
  const minutes = Number(window.windowDurationMins);
  if (minutes === 300) return tKey("quotaSources.window.fiveHour");
  if (minutes === 10080) return tKey("quotaSources.window.weekly");
  if (minutes === 43200) return tKey("quotaSources.window.monthly");
  if (Number.isFinite(minutes) && minutes > 0) return minutes % 1440 === 0 ? minutes / 1440 + "d" : Math.max(1, Math.round(minutes / 60)) + "h";
  return window.label || "";
}

function quotaWindowRemaining(window) {
  const value = Number.isFinite(window.remainingPercent) ? window.remainingPercent : 100 - Number(window.usedPercent);
  return Math.max(0, Math.min(100, Math.round(value)));
}

function quotaSourceName(source) {
  return source.id === "agents" ? tKey("quotaSources.source.agents") : source.id === "pi" ? tKey("quotaSources.source.pi")
    : source.id === "codexbar" ? "CodexBar" : "OpenCodex";
}

function quotaSourceStatus(source, host) {
  if (source.id === "agents") return tKey("quotaSources.agentsNote", { host });
  if (source.id === "pi") return tKey("quotaSources.piNote", { host });
  if (source.id === "codexbar") {
    if (!source.installed) return tKey("quotaSources.codexbarMissing", { host });
    if (!source.enabled) return tKey("quotaSources.codexbarOff", { host });
    return source.services?.length ? tKey("quotaSources.codexbarOn", { host }) : tKey("quotaSources.codexbarFailed");
  }
  if (!source.installed) return tKey("quotaSources.notInstalled", { host });
  if (!source.enabled) return tKey("quotaSources.off");
  if (!source.running) return tKey("quotaSources.stopped", { host });
  if (source.reason === "token_missing" || source.reason === "token_rejected") return tKey("quotaSources.tokenMissing", { port: source.port });
  return tKey("quotaSources.running", { port: source.port });
}

let quotaSourcesSaving = false;
async function saveQuotaSources(update) {
  const base = apiBase;
  if (quotaSourcesSaving) return;
  quotaSourcesSaving = true;
  renderQuotaSources();
  try {
    const data = await post("/api/quota-sources", update);
    if (apiBase === base) quotaSourcesState = { base, data, loading: false, error: null, at: Date.now() };
  } catch (error) {
    if (apiBase === base) toast(tKey("quotaSources.saveFailed", { detail: error?.message || "unknown error" }), true);
  } finally {
    quotaSourcesSaving = false;
    renderQuotaSources();
  }
}

// Each source is a card with its own switch and what it reads now; a service
// that several sources can read gets a choice of source below the cards.
function renderQuotaSources() {
  const list = el.quotaSourcesList;
  if (!list) return;
  const state = quotaSourcesState, host = agentTerminalHostName();
  list.replaceChildren();
  const note = (text, parent = list) => { const p = document.createElement("p"); p.className = "settings-note"; p.textContent = text; parent.appendChild(p); return p; };
  if (state.loading && !state.data) { note(tKey("quotaSources.loading")); return; }
  if (state.error) { note(state.error === "old" ? tKey("quotaSources.oldHost", { host }) : tKey("quotaSources.unavailable")); return; }
  const active = new Map((state.data?.services || []).map(row => [row.id, row.active]));
  const sameComputer = !apiBase && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(location.hostname);
  for (const source of state.data?.sources || []) {
    const card = document.createElement("div");
    card.className = "quota-source-card" + (source.enabled ? "" : " is-off");
    card.dataset.quotaSource = source.id;
    const head = document.createElement("div");
    head.className = "quota-source-head";
    const copy = document.createElement("div");
    copy.className = "quota-source-copy";
    const name = document.createElement("strong");
    name.textContent = quotaSourceName(source); name.dataset.i18nIgnore = "";
    const status = document.createElement("small");
    status.textContent = quotaSourceStatus(source, host);
    copy.append(name, status);
    const toggle = document.createElement("label");
    toggle.className = "toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!source.enabled;
    input.disabled = quotaSourcesSaving || (!source.installed && !source.enabled);
    input.setAttribute("aria-label", tKey("quotaSources.use", { name: quotaSourceName(source) }));
    input.addEventListener("change", () => void saveQuotaSources({ sources: { [source.id]: input.checked } }));
    const track = document.createElement("span");
    track.className = "toggle-track";
    toggle.append(input, track);
    head.append(copy, toggle);
    card.appendChild(head);
    // OpenCodex's own rows keep its extra windows; the others use what was read.
    const rows = source.id === "opencodex" && source.providers?.length
      ? source.providers.map(row => ({ id: row.id === "anthropic" ? "claude" : row.id === "openai" ? "codex" : row.id, label: row.label, windows: row.windows }))
      : (source.services || []).map(row => ({ id: row.service, label: row.label, windows: row.windows }));
    if (source.enabled && source.installed) {
      if (!rows.length && source.id !== "codexbar") note(tKey("quotaSources.nothing"), card);
      for (const row of rows) {
        const line = document.createElement("div");
        line.className = "quota-source-provider";
        const label = document.createElement("span");
        label.textContent = row.label; label.dataset.i18nIgnore = "";
        if (active.get(row.id) === source.id) {
          const tag = document.createElement("em");
          tag.className = "quota-source-inuse";
          tag.textContent = tKey("quotaSources.inUse");
          label.append(" ", tag);
        }
        const windows = document.createElement("span");
        windows.className = "quota-source-windows";
        const parts = (row.windows || []).map(window => (quotaWindowLabel(window) + " " + tKey("quotaSources.left", { percent: quotaWindowRemaining(window) })).trim());
        windows.textContent = parts.length ? parts.join(" · ") : tKey("quotaSources.noReading");
        line.append(label, windows);
        card.appendChild(line);
      }
    }
    // OpenCodex's dashboard listens on the host's loopback address, so it
    // opens only in a browser on that computer.
    if (source.id === "opencodex" && source.enabled && source.installed && source.dashboardUrl) {
      if (sameComputer && source.running) {
        const open = document.createElement("a");
        open.className = "btn ghost quota-source-open";
        open.href = source.dashboardUrl; open.target = "_blank"; open.rel = "noopener noreferrer";
        open.textContent = tKey("quotaSources.open", { name: "OpenCodex" });
        card.appendChild(open);
      } else note(tKey("quotaSources.openOnHost", { url: source.dashboardUrl, host }), card);
    }
    list.appendChild(card);
  }
  const shared = (state.data?.services || []).filter(row => row.sources.length > 1 || row.preferred);
  if (!shared.length) return;
  const names = Object.fromEntries((state.data?.sources || []).map(source => [source.id, quotaSourceName(source)]));
  const group = document.createElement("div");
  group.className = "quota-source-prefer";
  const title = document.createElement("strong");
  title.textContent = tKey("quotaSources.preferTitle");
  group.appendChild(title);
  for (const row of shared) {
    const line = document.createElement("label");
    line.className = "quota-source-prefer-row";
    const label = document.createElement("span");
    label.textContent = row.label; label.dataset.i18nIgnore = "";
    const select = document.createElement("select");
    select.disabled = quotaSourcesSaving;
    const auto = document.createElement("option");
    auto.value = ""; auto.textContent = tKey("quotaSources.auto");
    select.appendChild(auto);
    for (const id of new Set([...row.sources, ...(row.preferred ? [row.preferred] : [])])) {
      const option = document.createElement("option");
      option.value = id; option.textContent = names[id] || id;
      select.appendChild(option);
    }
    select.value = row.preferred || "";
    select.addEventListener("change", () => void saveQuotaSources({ prefer: { [row.id]: select.value || null } }));
    line.append(label, select);
    group.appendChild(line);
  }
  list.appendChild(group);
}
el.quotaSourcesRefresh?.addEventListener("click", () => void loadQuotaSources(true));


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
      const { wrap, bubble } = makeMsgShell("user", "你");
      wrap.dataset.ts = String(Date.now());
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
        goBackToList();
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
    // A swipe may start on a row button; only text and choice controls keep it.
    if (target.closest?.("input, select, textarea, [contenteditable=\"true\"], option")) return;
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
      // Inside a section the gesture returns to the section list, like the
      // toolbar back button, instead of closing Settings entirely.
      if (settingsCategory && !settingsSplitLayout()) {
        el.viewSettings.classList.add("snap-back");
        el.viewSettings.style.transform = "";
        settingsNavBack(() => showSettingsCategory(null));
        settingsSwipeTimer = setTimeout(() => {
          settingsSwipeTimer = null;
          el.viewSettings.classList.remove("snap-back");
        }, reducedMotion() ? 0 : 260);
        return;
      }
      if (reducedMotion()) {
        hideSettings();
        return;
      }
      el.viewSettings.classList.add("slide-out");
      el.viewSettings.style.transform = "translateX(100%)";
      settingsSwipeTimer = setTimeout(() => {
        settingsSwipeTimer = null;
        settingsNavBack(() => hideSettings());
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

// The same edge swipe on Models & providers leaves one level: an agent's page
// returns to the agent list, the list to the Agents section.
(() => {
  const view = el.viewModelSettings;
  if (!view) return;
  let gesture = null;
  const reset = () => { view.classList.remove("dragging"); view.style.transform = ""; };
  view.addEventListener("touchstart", (event) => {
    if (view.classList.contains("hidden") || event.touches.length !== 1) return;
    if (event.target.closest?.("input, select, textarea, [contenteditable=\"true\"], option")) return;
    const touch = event.touches[0];
    if (touch.clientX > 36) return;
    view.classList.remove("snap-back");
    gesture = { x0: touch.clientX, y0: touch.clientY, t0: Date.now(), dx: 0, active: false };
  }, { passive: true });
  view.addEventListener("touchmove", (event) => {
    if (!gesture) return;
    if (event.touches.length !== 1) { gesture = null; reset(); return; }
    const touch = event.touches[0];
    const dx = touch.clientX - gesture.x0, dy = touch.clientY - gesture.y0;
    if (!gesture.active) {
      if (dx > 12 && Math.abs(dx) > Math.abs(dy) * 1.6) { gesture.active = true; view.classList.add("dragging"); }
      else if (Math.abs(dy) > 14) { gesture = null; return; }
    }
    if (gesture.active) {
      event.preventDefault();
      gesture.dx = Math.max(0, dx);
      view.style.transform = `translateX(${gesture.dx}px)`;
    }
  }, { passive: false });
  const finish = (cancelled) => {
    const current = gesture;
    gesture = null;
    if (!current?.active) return;
    const elapsed = Math.max(1, Date.now() - current.t0);
    const back = !cancelled && (current.dx > 90 || (current.dx > 40 && (elapsed < 260 || current.dx / elapsed >= 0.65)));
    view.classList.remove("dragging");
    view.classList.add("snap-back");
    view.style.transform = "";
    setTimeout(() => view.classList.remove("snap-back"), 260);
    if (back) el.btnModelSettingsBack?.click();
  };
  view.addEventListener("touchend", () => finish(false));
  view.addEventListener("touchcancel", () => finish(true));
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
      { eyebrow: "MAKE IT YOURS", title: "Models and projects", body: "Type /login in a conversation to sign in to that agent, then choose a project folder to start a session.", points: ["Models & providers shows each agent's models and settings.", "New project can open your home folder or an allowed external drive."] },
      { eyebrow: "REMOTE ACCESS", title: "Connect securely", body: "For another computer or phone, keep the Node service on loopback and open Stepsemble through a private HTTPS address such as Tailscale Serve.", points: ["Use one-time pairing for an independent, revocable device credential; manual URL entry requires the same Web token.", "Never expose port 3140 directly to an untrusted network."] },
    ],
  },
  "zh-Hans": {
    guideTitle: "设置导览", guideSubtitle: "重新查看这台设备的基本设置", language: "语言", appearance: "外观", back: "返回", skip: "跳过", next: "继续", finish: "开始使用 Stepsemble",
    steps: [
      { eyebrow: "欢迎", title: "欢迎登船", body: "Stepsemble 为本机的 Pi Agent 提供一个简洁、专注，并同时适合电脑与手机的操作界面。", points: ["先选择语言与外观，之后仍可随时更改。", "Stepsemble 默认使用 Ink & Ivory 主题。"] },
      { eyebrow: "本机优先", title: "电脑仍是核心", body: "Stepsemble 是这台电脑上 Pi Agent 的操作界面。工作阶段、凭证与项目文件都会留在主机上。", points: ["Stepsemble 不会把你的项目搬到托管云端。", "每一台要使用的电脑都需要各自安装 Stepsemble。"] },
      { eyebrow: "开始配置", title: "模型与项目", body: "在对话输入 /login 登录该 Agent，然后选择项目文件夹来开始工作阶段。", points: ["“模型与 Provider”会显示每个 Agent 的模型与设置。", "“新建项目”可以打开主文件夹或允许访问的外接硬盘。"] },
      { eyebrow: "远程访问", title: "安全连接", body: "要从其他电脑或手机使用，请让 Node 服务只监听本机，并通过 Tailscale Serve 等私有 HTTPS 地址打开 Stepsemble。", points: ["使用一次性配对可取得独立且可撤销的设备凭证；手动输入网址仍要求两台电脑使用相同的 Web token。", "不要把 3140 端口直接开放到不受信任的网络。"] },
    ],
  },
  "zh-Hant": {
    guideTitle: "設定導覽", guideSubtitle: "重新查看這台裝置的基本設定", language: "語言", appearance: "外觀", back: "返回", skip: "略過", next: "繼續", finish: "開始使用 Stepsemble",
    steps: [
      { eyebrow: "歡迎", title: "歡迎登船", body: "Stepsemble 為本機的 Pi Agent 提供一個簡潔、專注，並同時適合電腦與手機的操作介面。", points: ["先選擇語言與外觀，之後仍可隨時更改。", "Stepsemble 預設使用 Ink & Ivory 主題。"] },
      { eyebrow: "本機優先", title: "電腦仍是核心", body: "Stepsemble 是這台電腦上 Pi Agent 的操作介面。工作階段、憑證與專案檔案都會留在主機上。", points: ["Stepsemble 不會把你的專案搬到託管雲端。", "每一台要使用的電腦都需要各自安裝 Stepsemble。"] },
      { eyebrow: "開始設定", title: "模型與專案", body: "在對話輸入 /login 登入該 Agent，然後選擇專案資料夾來開始工作階段。", points: ["「模型與 Provider」會顯示每個 Agent 的模型與設定。", "「新增專案」可以開啟家目錄或允許存取的外接硬碟。"] },
      { eyebrow: "遠端存取", title: "安全連線", body: "要從其他電腦或手機使用，請讓 Node 服務只監聽本機，並透過 Tailscale Serve 等私有 HTTPS 位址開啟 Stepsemble。", points: ["使用一次性配對可取得獨立且可撤銷的裝置憑證；手動輸入網址仍要求兩台電腦使用相同的 Web token。", "不要把 3140 port 直接開放到不受信任的網路。"] },
    ],
  },
  ja: {
    guideTitle: "セットアップガイド", guideSubtitle: "このデバイスの基本設定を確認", language: "言語", appearance: "外観", back: "戻る", skip: "スキップ", next: "次へ", finish: "Stepsemble を使い始める",
    steps: [
      { eyebrow: "ようこそ", title: "Stepsemble へようこそ", body: "Stepsemble は、このMac上の Pi Agent をデスクトップでもモバイルでも快適に操作できる、落ち着いたインターフェイスです。", points: ["言語と外観は後からいつでも変更できます。", "既定のテーマは Ink & Ivory です。"] },
      { eyebrow: "ローカル優先", title: "主役はこのコンピュータ", body: "Stepsemble はこのコンピュータにある Pi Agent の操作画面です。セッション、認証情報、プロジェクトファイルはホストに残ります。", points: ["プロジェクトを外部のホスティング環境へ移動しません。", "利用する各コンピュータに Stepsemble のインストールが必要です。"] },
      { eyebrow: "準備", title: "モデルとプロジェクト", body: "会話で /login と入力してそのエージェントにサインインし、プロジェクトフォルダを選んでセッションを始めます。", points: ["モデルとプロバイダーで、各エージェントのモデルと設定を確認できます。", "新規プロジェクトからホームまたは許可済みの外部ドライブを開けます。"] },
      { eyebrow: "リモートアクセス", title: "安全に接続", body: "別のコンピュータやスマートフォンから使う場合は、Node サービスをループバックのままにし、Tailscale Serve などのプライベート HTTPS 経由で開きます。", points: ["ワンタイムペアリングでは独立して取り消せる認証情報が作成され、同じ Web トークンが必要なのは URL を手動入力する場合だけです。", "ポート 3140 を信頼できないネットワークへ直接公開しないでください。"] },
    ],
  },
  ko: {
    guideTitle: "설정 안내", guideSubtitle: "이 기기의 기본 설정 다시 보기", language: "언어", appearance: "화면 모드", back: "뒤로", skip: "건너뛰기", next: "계속", finish: "Stepsemble 시작하기",
    steps: [
      { eyebrow: "환영합니다", title: "Stepsemble에 오신 것을 환영합니다", body: "Stepsemble는 이 컴퓨터의 Pi Agent를 데스크톱과 모바일에서 편안하게 사용할 수 있는 깔끔한 인터페이스입니다.", points: ["언어와 화면 모드는 나중에도 언제든 바꿀 수 있습니다.", "기본 테마는 Ink & Ivory입니다."] },
      { eyebrow: "로컬 우선", title: "컴퓨터가 중심입니다", body: "Stepsemble는 이 컴퓨터에 설치된 Pi Agent의 인터페이스입니다. 세션, 자격 증명, 프로젝트 파일은 호스트에 남습니다.", points: ["프로젝트를 외부 호스팅 클라우드로 옮기지 않습니다.", "사용할 컴퓨터마다 Stepsemble를 설치해야 합니다."] },
      { eyebrow: "설정", title: "모델과 프로젝트", body: "대화에서 /login을 입력해 그 에이전트에 로그인한 뒤 프로젝트 폴더를 선택해 세션을 시작하세요.", points: ["모델 및 Provider 화면에서 각 에이전트의 모델과 설정을 볼 수 있습니다.", "새 프로젝트에서 홈 폴더 또는 허용된 외장 드라이브를 열 수 있습니다."] },
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
    { eyebrow: "MODELS & SIGN-IN", title: "Sign in and choose models", body: "Type /login in a conversation with any agent; it runs that agent's own sign-in on the host. Settings → Agents & models → Models & providers shows each agent's models and settings.", points: ["Credentials stay with each agent on the selected host.", "Quota sources show subscription and API limits, including from OpenCodex."] },
    { eyebrow: "PROJECT", title: "Choose a folder and start", body: "In the Workspace, choose Add project and pick a folder on this host. Then choose New session in that project, pick an agent, optionally name it, and create it.", points: ["The folder picker starts at the host home when allowed, otherwise at an allowed root.", "You can return to this guide from Settings → About → Setup guide."] },
  ],
  "zh-Hans": [
    { eyebrow: "欢迎", title: "欢迎使用", body: "Stepsemble 会将 Pi Agent、会话、凭证和项目保留在选定的电脑上。", points: ["现在选择语言和外观，之后都可以更改。"] },
    { eyebrow: "TOKEN 与登录", title: "找到 Web token", body: "安装程序会在运行 Stepsemble 的电脑上创建私密 Web token。在那台电脑打开终端并运行 cat ~/.config/stepsemble/token，然后将结果粘贴到这里。在其他设备上，请从该主机安全地取得 token。", points: ["绝不要在聊天、截图、代码仓库或日志中分享 token。", "如果配置了 STEPSEMBLE_TOKEN_FILE，请使用该文件，而不是默认路径。"] },
    { eyebrow: "设备", title: "连接另一台电脑", body: "在每台额外的电脑上安装并运行 Stepsemble。使用 Tailscale 或 HTTPS，然后打开“设置 → 设备 → 添加设备”，也可以使用五分钟有效的一次性配对码。", points: ["优先使用一次性配对来取得独立且可撤销的凭证；只有手动输入网址时才需要相同的 Web token。", "不要将公共 3140 端口暴露给不受信任的网络。"] },
    { eyebrow: "模型与登录", title: "登录并选择模型", body: "在任何 Agent 的对话输入 /login，会在主机上运行该 Agent 自己的登录。“设置 → Agent 与模型 → 模型与 Provider”会显示每个 Agent 的模型与设置。", points: ["凭证留在所选主机上各 Agent 自己那里。", "“额度来源”会显示订阅与 API 额度，包括来自 OpenCodex 的数据。"] },
    { eyebrow: "项目", title: "选择文件夹并开始", body: "在 Workspace 选择“添加项目”并选好这台主机上的文件夹，再在该项目中选择“新建会话”，选好 Agent、可选填写名称，然后创建。", points: ["文件夹选择器会在获准时从主机主目录开始，否则从获准的根目录开始。", "以后可以从“设置 → 关于 → 设置导览”再次打开本指南。"] },
  ],
  "zh-Hant": [
    { eyebrow: "歡迎", title: "歡迎使用", body: "Stepsemble 會將 Pi Agent、工作階段、憑證與專案保留在選定的電腦上。", points: ["現在選擇語言與外觀，之後都可以更改。"] },
    { eyebrow: "TOKEN 與登入", title: "找到 Web token", body: "安裝程式會在執行 Stepsemble 的電腦上建立私密 Web token。在該電腦開啟終端機並執行 cat ~/.config/stepsemble/token，然後將結果貼到這裡。在其他裝置上，請從該主機安全地取得 token。", points: ["絕不要在聊天、截圖、程式碼儲存庫或日誌中分享 token。", "如果設定了 STEPSEMBLE_TOKEN_FILE，請使用該檔案，不要使用預設路徑。"] },
    { eyebrow: "裝置", title: "連接另一台電腦", body: "在每台額外的電腦上安裝並執行 Stepsemble。使用 Tailscale 或 HTTPS，然後開啟「設定 → 設備 → 新增設備」，也可以使用五分鐘有效的一次性配對碼。", points: ["優先使用一次性配對來取得獨立且可撤銷的憑證；只有手動輸入網址時才需要相同的 Web token。", "不要將公開的 3140 port 暴露給不受信任的網路。"] },
    { eyebrow: "模型與登入", title: "登入並選擇模型", body: "在任何 Agent 的對話輸入 /login，會在主機上執行該 Agent 自己的登入。「設定 → Agent 與模型 → 模型與 Provider」會顯示每個 Agent 的模型與設定。", points: ["憑證留在所選主機上各 Agent 自己那裡。", "「額度來源」會顯示訂閱與 API 額度，包括來自 OpenCodex 的資料。"] },
    { eyebrow: "專案", title: "選擇資料夾並開始", body: "在 Workspace 選擇「新增專案」並選好這台主機上的資料夾，再在該專案中選擇「新增對話」，選好 Agent、可選填寫名稱，然後建立。", points: ["資料夾選擇器會在獲准時從主機家目錄開始，否則從獲准的根目錄開始。", "之後可以從「設定 → 關於 → 設定導覽」再次開啟本指南。"] },
  ],
  ja: [
    { eyebrow: "ようこそ", title: "Stepsemble へようこそ", body: "Stepsemble は Pi Agent、セッション、認証情報、プロジェクトを選択したコンピューターに保管します。", points: ["言語と外観は今選択でき、後から変更できます。"] },
    { eyebrow: "トークンとサインイン", title: "Web トークンを確認", body: "インストーラーは Stepsemble を実行するコンピューターに非公開の Web トークンを作成します。そのコンピューターでターミナルを開き、cat ~/.config/stepsemble/token を実行して、結果をここに貼り付けます。別のデバイスでは、そのホストから安全にトークンを取得してください。", points: ["トークンをチャット、スクリーンショット、リポジトリ、ログで共有しないでください。", "カスタムの STEPSEMBLE_TOKEN_FILE を設定している場合は、既定のパスではなくそのファイルを使います。"] },
    { eyebrow: "デバイス", title: "別のコンピューターを接続", body: "追加する各コンピューターに Stepsemble をインストールして実行します。Tailscale または HTTPS を使い、「設定 → デバイス → デバイスを追加」を開くか、5 分間有効なペアリングコードを使います。", points: ["独立して取り消せる認証情報にはワンタイムペアリングを使います。同じ Web トークンが必要なのは URL を手動入力する場合だけです。", "公開ポート 3140 を信頼できないネットワークに公開しないでください。"] },
    { eyebrow: "モデルとサインイン", title: "サインインしてモデルを選ぶ", body: "どのエージェントでも、会話で /login と入力すると、ホスト上でそのエージェント自身のサインインが動きます。「設定 → エージェントとモデル → モデルとプロバイダー」に各エージェントのモデルと設定があります。", points: ["認証情報は、選択したホスト上の各エージェントに残ります。", "「利用枠の取得元」で、OpenCodex などからのサブスクリプションと API の上限を確認できます。"] },
    { eyebrow: "プロジェクト", title: "フォルダーを選んで開始", body: "Workspace で「プロジェクトを追加」を選び、このホストのフォルダーを選びます。次にそのプロジェクトで「新しい会話」を選び、エージェントを選んで、必要なら名前を入力して作成します。", points: ["フォルダー選択は、許可されていればホストのホームから、それ以外は許可されたルートから始まります。", "後で「設定 → 概要 → セットアップガイド」から再び開けます。"] },
  ],
  ko: [
    { eyebrow: "환영합니다", title: "Stepsemble에 오신 것을 환영합니다", body: "Stepsemble는 Pi Agent, 세션, 자격 증명과 프로젝트를 선택한 컴퓨터에 보관합니다.", points: ["지금 언어와 화면 모드를 선택할 수 있으며 나중에 변경할 수 있습니다."] },
    { eyebrow: "토큰 및 로그인", title: "Web 토큰 찾기", body: "설치 프로그램이 Stepsemble를 실행하는 컴퓨터에 비공개 Web 토큰을 만듭니다. 해당 컴퓨터에서 터미널을 열고 cat ~/.config/stepsemble/token을 실행한 뒤 결과를 여기에 붙여넣으세요. 다른 기기에서는 해당 호스트에서 토큰을 안전하게 가져오세요.", points: ["토큰을 채팅, 스크린샷, 저장소 또는 로그에 절대 공유하지 마세요.", "사용자 지정 STEPSEMBLE_TOKEN_FILE을 설정했다면 기본 경로 대신 해당 파일을 사용하세요."] },
    { eyebrow: "기기", title: "다른 컴퓨터 연결", body: "추가할 각 컴퓨터에 Stepsemble를 설치하고 실행하세요. Tailscale 또는 HTTPS를 사용한 뒤 ‘설정 → 기기 → 기기 추가’를 열거나 5분 동안 유효한 페어링 코드를 사용하세요.", points: ["독립적으로 취소할 수 있는 인증 정보에는 일회용 페어링을 사용하세요. 같은 Web 토큰은 URL을 수동으로 입력할 때만 필요합니다.", "공개 포트 3140을 신뢰할 수 없는 네트워크에 노출하지 마세요."] },
    { eyebrow: "모델 및 로그인", title: "로그인하고 모델 선택", body: "어떤 에이전트든 대화에서 /login을 입력하면 호스트에서 그 에이전트 자체의 로그인이 실행됩니다. ‘설정 → 에이전트와 모델 → 모델 및 Provider’에서 각 에이전트의 모델과 설정을 볼 수 있습니다.", points: ["자격 증명은 선택한 호스트의 각 에이전트에 남습니다.", "‘한도 출처’에서 OpenCodex 등의 구독 및 API 한도를 볼 수 있습니다."] },
    { eyebrow: "프로젝트", title: "폴더를 선택하고 시작", body: "Workspace에서 ‘프로젝트 추가’를 선택해 이 호스트의 폴더를 고르세요. 그런 다음 그 프로젝트에서 ‘새 세션’을 선택하고 에이전트를 고른 뒤, 필요하면 이름을 입력해 만드세요.", points: ["폴더 선택기는 허용된 경우 호스트 홈에서, 그렇지 않으면 허용된 루트에서 시작합니다.", "나중에 ‘설정 → 정보 → 설정 안내’에서 이 안내를 다시 열 수 있습니다."] },
  ],
  tr: [
    { eyebrow: "HOŞ GELDİNİZ", title: "Stepsemble'a hoş geldiniz", body: "Stepsemble; Pi Agent'ı, oturumları, kimlik bilgilerini ve projeleri seçtiğiniz bilgisayarda tutar.", points: ["Dil ve görünümü şimdi seçebilirsiniz; daha sonra da değiştirebilirsiniz."] },
    { eyebrow: "TOKEN VE GİRİŞ", title: "Web token'ını bulun", body: "Yükleyici, Stepsemble'ı çalıştıran bilgisayarda özel bir Web token'ı oluşturur. Bu bilgisayarda Terminal'i açıp cat ~/.config/stepsemble/token komutunu çalıştırın ve sonucu buraya yapıştırın. Başka bir cihazda token'ı bu ana bilgisayardan güvenli şekilde alın.", points: ["Token'ı sohbetlerde, ekran görüntülerinde, depolarda veya günlüklerde asla paylaşmayın.", "Özel bir STEPSEMBLE_TOKEN_FILE yapılandırıldıysa varsayılan yol yerine bu dosyayı kullanın."] },
    { eyebrow: "CİHAZLAR", title: "Başka bir bilgisayarı bağlayın", body: "Eklediğiniz her bilgisayara Stepsemble'i yükleyip çalıştırın. Tailscale veya HTTPS kullanın; ardından Ayarlar → Cihazlar → Cihaz ekle yolunu açın ya da beş dakika geçerli bir eşleştirme kodu kullanın.", points: ["Bağımsız ve iptal edilebilir kimlik bilgisi için tek kullanımlık eşleştirmeyi tercih edin; aynı Web token'ı yalnızca URL elle girildiğinde gerekir.", "3140 numaralı genel bağlantı noktasını güvenilmeyen bir ağa açmayın."] },
    { eyebrow: "MODELLER VE OTURUM", title: "Oturum açın ve model seçin", body: "Herhangi bir ajanla sohbette /login yazın; ana makinede o ajanın kendi oturum açma komutu çalışır. Ayarlar → Ajanlar ve modeller → Modeller ve sağlayıcılar her ajanın modellerini ve ayarlarını gösterir.", points: ["Kimlik bilgileri seçili ana makinede her ajanın kendisinde kalır.", "Kota kaynakları, OpenCodex dahil abonelik ve API sınırlarını gösterir."] },
    { eyebrow: "PROJE", title: "Klasör seçip başlayın", body: "Workspace'te Proje ekle'yi seçip bu ana bilgisayardaki bir klasörü seçin. Ardından o projede Yeni oturum'u seçin, bir ajan seçin, isterseniz ad verin ve oluşturun.", points: ["Klasör seçici izin verilmişse ana bilgisayarın ana klasöründe, aksi halde izin verilen bir kökte başlar.", "Bu rehberi daha sonra Ayarlar → Hakkında → Kurulum rehberi bölümünden açabilirsiniz."] },
  ],
  fr: [
    { eyebrow: "BIENVENUE", title: "Bienvenue sur Stepsemble", body: "Stepsemble conserve l’agent Pi, les sessions, les identifiants et les projets sur l’ordinateur sélectionné.", points: ["Choisissez la langue et l’apparence maintenant ; vous pourrez les modifier plus tard."] },
    { eyebrow: "JETON ET CONNEXION", title: "Trouver votre jeton Web", body: "L’installeur crée un jeton Web privé sur l’ordinateur qui exécute Stepsemble. Sur cet ordinateur, ouvrez le Terminal et exécutez cat ~/.config/stepsemble/token, puis collez le résultat ici. Depuis un autre appareil, récupérez le jeton en toute sécurité sur cet hôte.", points: ["Ne partagez jamais le jeton dans un chat, une capture d’écran, un dépôt ou un journal.", "Si un STEPSEMBLE_TOKEN_FILE personnalisé est configuré, utilisez ce fichier plutôt que le chemin par défaut."] },
    { eyebrow: "APPAREILS", title: "Connecter un autre ordinateur", body: "Installez et lancez Stepsemble sur chaque ordinateur supplémentaire. Utilisez Tailscale ou HTTPS, puis ouvrez Réglages → Appareils → Ajouter un appareil, ou utilisez un code d’association valable cinq minutes.", points: ["Préférez l’association à usage unique pour un identifiant indépendant et révocable ; le même jeton Web n’est requis que pour la saisie manuelle d’une URL.", "N’exposez jamais le port public 3140 à un réseau non fiable."] },
    { eyebrow: "MODÈLES ET CONNEXION", title: "Se connecter et choisir les modèles", body: "Tapez /login dans une conversation avec n’importe quel agent : la connexion propre à cet agent s’exécute sur l’hôte. Réglages → Agents et modèles → Modèles et fournisseurs affiche les modèles et réglages de chaque agent.", points: ["Les identifiants restent auprès de chaque agent sur l’hôte sélectionné.", "Les sources des quotas affichent les limites d’abonnement et d’API, y compris depuis OpenCodex."] },
    { eyebrow: "PROJET", title: "Choisir un dossier et commencer", body: "Dans le Workspace, choisissez Ajouter un projet et un dossier sur cet hôte. Ensuite, dans ce projet, choisissez Nouvelle session, un agent, éventuellement un nom, puis créez-la.", points: ["Le sélecteur commence dans le dossier personnel de l’hôte s’il est autorisé, sinon dans une racine autorisée.", "Vous pourrez rouvrir ce guide dans Réglages → À propos → Guide de configuration."] },
  ],
  de: [
    { eyebrow: "WILLKOMMEN", title: "Willkommen bei Stepsemble", body: "Stepsemble bewahrt Pi Agent, Sitzungen, Zugangsdaten und Projekte auf dem ausgewählten Computer auf.", points: ["Wählen Sie Sprache und Darstellung jetzt aus; beides lässt sich später ändern."] },
    { eyebrow: "TOKEN UND ANMELDUNG", title: "Web-Token finden", body: "Das Installationsprogramm erstellt ein privates Web-Token auf dem Computer, auf dem Stepsemble läuft. Öffnen Sie dort das Terminal und führen Sie cat ~/.config/stepsemble/token aus. Fügen Sie das Ergebnis hier ein. Rufen Sie das Token auf einem anderen Gerät sicher von diesem Host ab.", points: ["Teilen Sie das Token niemals in Chats, Screenshots, Repositories oder Protokollen.", "Wenn ein eigenes STEPSEMBLE_TOKEN_FILE konfiguriert ist, verwenden Sie diese Datei statt des Standardpfads."] },
    { eyebrow: "GERÄTE", title: "Anderen Computer verbinden", body: "Installieren und starten Sie Stepsemble auf jedem weiteren Computer. Verwenden Sie Tailscale oder HTTPS und öffnen Sie Einstellungen → Geräte → Gerät hinzufügen oder verwenden Sie einen fünf Minuten gültigen Kopplungscode.", points: ["Bevorzugen Sie die einmalige Kopplung für eine unabhängige, widerrufbare Anmeldung; dasselbe Web-Token ist nur bei manueller URL-Eingabe erforderlich.", "Geben Sie den öffentlichen Port 3140 nie in einem nicht vertrauenswürdigen Netzwerk frei."] },
    { eyebrow: "MODELLE UND ANMELDUNG", title: "Anmelden und Modelle wählen", body: "Geben Sie in einer Unterhaltung mit einem beliebigen Agenten /login ein; auf dem Host läuft dann dessen eigene Anmeldung. Einstellungen → Agenten & Modelle → Modelle und Anbieter zeigt Modelle und Einstellungen jedes Agenten.", points: ["Zugangsdaten bleiben beim jeweiligen Agenten auf dem ausgewählten Host.", "Kontingentquellen zeigen Abo- und API-Limits, auch aus OpenCodex."] },
    { eyebrow: "PROJEKT", title: "Ordner auswählen und starten", body: "Wählen Sie im Workspace Projekt hinzufügen und einen Ordner auf diesem Host. Wählen Sie dann in diesem Projekt Neue Sitzung, einen Agenten und optional einen Namen, und erstellen Sie sie.", points: ["Die Ordnerauswahl beginnt im Home-Ordner des Hosts, wenn er erlaubt ist, andernfalls in einer erlaubten Wurzel.", "Sie können den Assistenten später unter Einstellungen → Über → Einrichtungsassistent erneut öffnen."] },
  ],
  es: [
    { eyebrow: "BIENVENIDA", title: "Bienvenido a Stepsemble", body: "Stepsemble conserva el agente Pi, las sesiones, las credenciales y los proyectos en el ordenador seleccionado.", points: ["Elige ahora el idioma y la apariencia; podrás cambiarlos más adelante."] },
    { eyebrow: "TOKEN E INICIO DE SESIÓN", title: "Encuentra tu token web", body: "El instalador crea un token web privado en el ordenador que ejecuta Stepsemble. En ese ordenador, abre Terminal y ejecuta cat ~/.config/stepsemble/token; después pega el resultado aquí. Desde otro dispositivo, recupera el token de forma segura en ese equipo anfitrión.", points: ["Nunca compartas el token en chats, capturas de pantalla, repositorios ni registros.", "Si se ha configurado un STEPSEMBLE_TOKEN_FILE personalizado, usa ese archivo en lugar de la ruta predeterminada."] },
    { eyebrow: "DISPOSITIVOS", title: "Conecta otro ordenador", body: "Instala y ejecuta Stepsemble en cada ordenador adicional. Usa Tailscale o HTTPS y abre Ajustes → Dispositivos → Añadir dispositivo, o utiliza un código de emparejamiento válido durante cinco minutos.", points: ["Prefiere el emparejamiento de un solo uso para obtener una credencial independiente y revocable; el mismo token web solo se necesita al introducir la URL manualmente.", "No expongas el puerto público 3140 directamente a una red que no sea de confianza."] },
    { eyebrow: "MODELOS E INICIO DE SESIÓN", title: "Inicia sesión y elige modelos", body: "Escribe /login en una conversación con cualquier agente; en el equipo se ejecuta el inicio de sesión propio de ese agente. Ajustes → Agentes y modelos → Modelos y proveedores muestra los modelos y ajustes de cada agente.", points: ["Las credenciales quedan con cada agente en el equipo seleccionado.", "Las fuentes de cuota muestran los límites de suscripción y de API, también desde OpenCodex."] },
    { eyebrow: "PROYECTO", title: "Elige una carpeta y empieza", body: "En el Workspace, elige Añadir proyecto y una carpeta de este equipo anfitrión. Después, en ese proyecto, elige Nueva sesión, un agente y, si quieres, un nombre, y créala.", points: ["El selector empieza en la carpeta personal del equipo si está permitida; de lo contrario, en una raíz permitida.", "Puedes volver a abrir esta guía desde Ajustes → Acerca de → Guía de configuración."] },
  ],
  "pt-BR": [
    { eyebrow: "BOAS-VINDAS", title: "Bem-vindo ao Stepsemble", body: "O Stepsemble mantém o Pi Agent, as sessões, as credenciais e os projetos no computador selecionado.", points: ["Escolha o idioma e a aparência agora; ambos podem ser alterados depois."] },
    { eyebrow: "TOKEN E LOGIN", title: "Encontre seu token Web", body: "O instalador cria um token Web privado no computador que executa o Stepsemble. Nesse computador, abra o Terminal e execute cat ~/.config/stepsemble/token; depois cole o resultado aqui. Em outro dispositivo, obtenha o token com segurança nesse host.", points: ["Nunca compartilhe o token em chats, capturas de tela, repositórios ou logs.", "Se um STEPSEMBLE_TOKEN_FILE personalizado estiver configurado, use esse arquivo em vez do caminho padrão."] },
    { eyebrow: "DISPOSITIVOS", title: "Conecte outro computador", body: "Instale e execute o Stepsemble em cada computador adicional. Use Tailscale ou HTTPS e abra Configurações → Dispositivos → Adicionar dispositivo, ou use um código de pareamento válido por cinco minutos.", points: ["Prefira o pareamento de uso único para obter uma credencial independente e revogável; o mesmo token Web só é necessário ao informar a URL manualmente.", "Não exponha a porta pública 3140 diretamente a uma rede não confiável."] },
    { eyebrow: "MODELOS E LOGIN", title: "Entre e escolha os modelos", body: "Digite /login em uma conversa com qualquer agente; o login do próprio agente roda no host. Configurações → Agentes e modelos → Modelos e provedores mostra os modelos e as configurações de cada agente.", points: ["As credenciais ficam com cada agente no host selecionado.", "As fontes de cota mostram os limites de assinatura e de API, inclusive do OpenCodex."] },
    { eyebrow: "PROJETO", title: "Escolha uma pasta e comece", body: "No Workspace, escolha Adicionar projeto e uma pasta neste host. Depois, nesse projeto, escolha Nova sessão, um agente e, se quiser, um nome, e crie a sessão.", points: ["O seletor começa na pasta pessoal do host quando ela é permitida; caso contrário, em uma raiz permitida.", "Você pode reabrir este guia em Configurações → Sobre → Guia de configuração."] },
  ],
  it: [
    { eyebrow: "BENVENUTO", title: "Benvenuto in Stepsemble", body: "Stepsemble conserva Pi Agent, sessioni, credenziali e progetti sul computer selezionato.", points: ["Scegli ora lingua e aspetto; potrai modificarli in seguito."] },
    { eyebrow: "TOKEN E ACCESSO", title: "Trova il token Web", body: "Il programma di installazione crea un token Web privato sul computer che esegue Stepsemble. Su quel computer apri Terminale ed esegui cat ~/.config/stepsemble/token, quindi incolla il risultato qui. Da un altro dispositivo, recupera il token in modo sicuro da quell’host.", points: ["Non condividere mai il token in chat, schermate, repository o log.", "Se è configurato un STEPSEMBLE_TOKEN_FILE personalizzato, usa quel file invece del percorso predefinito."] },
    { eyebrow: "DISPOSITIVI", title: "Collega un altro computer", body: "Installa e avvia Stepsemble su ogni computer aggiuntivo. Usa Tailscale o HTTPS, quindi apri Impostazioni → Dispositivi → Aggiungi dispositivo oppure usa un codice di abbinamento valido cinque minuti.", points: ["Preferisci l’abbinamento una tantum per una credenziale indipendente e revocabile; lo stesso token Web serve solo quando inserisci manualmente l’URL.", "Non esporre la porta pubblica 3140 a una rete non attendibile."] },
    { eyebrow: "MODELLI E ACCESSO", title: "Accedi e scegli i modelli", body: "Digita /login in una conversazione con qualsiasi agent: sull’host si avvia l’accesso proprio di quell’agent. Impostazioni → Agenti e modelli → Modelli e provider mostra i modelli e le impostazioni di ogni agent.", points: ["Le credenziali restano presso ciascun agent sull’host selezionato.", "Le fonti delle quote mostrano i limiti di abbonamento e API, anche da OpenCodex."] },
    { eyebrow: "PROGETTO", title: "Scegli una cartella e inizia", body: "Nel Workspace scegli Aggiungi progetto e una cartella su questo host. Poi, in quel progetto, scegli Nuova sessione, un agent e, se vuoi, un nome, e creala.", points: ["Il selettore parte dalla cartella home dell’host se autorizzata, altrimenti da una radice autorizzata.", "Puoi riaprire questa guida da Impostazioni → Informazioni → Guida alla configurazione."] },
  ],
};
for (const [locale, steps] of Object.entries(ONBOARDING_ACTIONABLE_STEPS)) {
  if (ONBOARDING_COPY[locale]) ONBOARDING_COPY[locale].steps = steps;
}

// Gesture guidance belongs in the setup guide, not in a permanent Settings row.
// Keep it localized here because onboarding copy is intentionally rendered
// outside the generic DOM translator.
const ONBOARDING_GESTURE_TIPS = {
  en: "Swipe from the left edge in a conversation or Settings to go back; rename, export or delete a conversation from its ⋯ menu",
  "zh-Hans": "在对话或设置中从左侧边缘向右滑可返回；在对话的 ⋯ 菜单中可重命名、导出或删除。",
  "zh-Hant": "在對話或設定中從左側邊緣向右滑可返回；在對話的 ⋯ 選單中可重新命名、匯出或刪除。",
  ja: "会話または設定で左端からスワイプすると戻ります。会話の ⋯ メニューから名前変更、書き出し、削除ができます。",
  ko: "대화나 설정에서 왼쪽 가장자리에서 밀면 뒤로 갑니다. 대화의 ⋯ 메뉴에서 이름 바꾸기, 내보내기, 삭제를 할 수 있습니다.",
  tr: "Konuşma veya Ayarlar'dan geri dönmek için sol kenardan kaydırın; bir konuşmayı ⋯ menüsünden yeniden adlandırın, dışa aktarın veya silin.",
  fr: "Dans une conversation ou les réglages, balayez depuis le bord gauche pour revenir ; renommez, exportez ou supprimez une conversation depuis son menu ⋯.",
  de: "In einer Unterhaltung oder den Einstellungen vom linken Rand wischen, um zurückzugehen; eine Unterhaltung über ihr ⋯-Menü umbenennen, exportieren oder löschen.",
  es: "En una conversación o en Ajustes, desliza desde el borde izquierdo para volver; cambia el nombre, exporta o elimina una conversación desde su menú ⋯.",
  "pt-BR": "Em uma conversa ou nas configurações, deslize da borda esquerda para voltar; renomeie, exporte ou exclua uma conversa pelo menu ⋯.",
  it: "In una conversazione o nelle impostazioni, scorri dal bordo sinistro per tornare indietro; rinomina, esporta o elimina una conversazione dal suo menu ⋯.",
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
  if (!machines.length && !workspaceAfterGuide) {
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
  if (workspaceAfterGuide) location.replace(workspaceDestination());
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
    button.dataset.themeSwatch = theme.id;
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
  // The row shows the current theme; the full palette opens on demand so it
  // does not take a whole phone screen.
  const current = DESIGN_THEMES.find((theme) => theme.id === settings.designTheme) || DESIGN_THEMES[0];
  if (el.themeCurrentName) el.themeCurrentName.textContent = current?.label || "";
  if (el.themeCurrentSwatches && current) el.themeCurrentSwatches.dataset.themeSwatch = current.id;
  el.themeChoicesToggle?.setAttribute("aria-expanded", String(!el.setDesignTheme.hidden));
}
el.themeChoicesToggle?.addEventListener("click", () => {
  if (!el.setDesignTheme) return;
  el.setDesignTheme.hidden = !el.setDesignTheme.hidden;
  renderThemeChoices();
});

let updateStatusData = null;
let updateStatusRequest = 0;
let updateDeviceStatuses = new Map();
let harnessUpdateDataByDevice = new Map();
let updateCenterRequest = null;
let updateCenterAbort = null;
let updateCenterPollTimer = null;
let updateAllController = null;
let updateAllRequest = 0;
let harnessUpdateRequest = 0;
let harnessUpdateController = null;
const harnessUpdateInFlight = new Set();
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

async function fetchMachineHarnessStatus(machine, signal) {
  try {
    const result = await requestMachineUpdate(machine, "/api/harness-updates/status", undefined, { signal, timeoutMs: 9000 });
    if (!result.data || typeof result.data !== "object") throw updateRequestError("Harness update status was unavailable", 502, true);
    return result.data;
  } catch (error) {
    if ([404, 405].includes(Number(error?.status))) return { unsupported: true, harnesses: [] };
    throw error;
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

function updateNextCheckAt(updater) {
  if (updater?.nextCheckAt) return updater.nextCheckAt;
  if (!updater?.enabled || updater.installed === false || !updater?.lastCheckedAt) return null;
  const interval = Number(updater.intervalMinutes) || 60;
  const checked = Date.parse(updater.lastCheckedAt);
  return Number.isFinite(checked) ? new Date(checked + interval * 60 * 1000).toISOString() : null;
}

// Mirrors the Host's release comparison for display only; the Host decides.
function updateReleaseIsNewer(current, latest) {
  const parts = (value) => {
    const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-.]([A-Za-z0-9.-]+))?$/);
    return match ? { numbers: match.slice(1, 4).map(Number), pre: match[4] || "" } : null;
  };
  const installed = parts(current);
  const published = parts(latest);
  if (!published || !installed) return false;
  for (let index = 0; index < 3; index += 1) {
    if (published.numbers[index] !== installed.numbers[index]) return published.numbers[index] > installed.numbers[index];
  }
  return !published.pre && !!installed.pre;
}

const updateInstallInFlight = new Set();
const updateAutoInFlight = new Set();
let updateInstallAllRunning = false;

// One place decides what a device row says and which actions it offers, so
// the row, the "install on all" button and the section summary never disagree.
function updateDeviceView(machine) {
  const entry = updateEntryFor(machine);
  const data = entry?.data;
  const updater = data?.updater;
  const current = String(data?.appVersion || data?.currentVersion || updater?.currentVersion || "");
  const latest = String(updater?.latestVersion || data?.latestVersion || "");
  const view = { entry, updater, current, latest, tone: "muted", text: "", install: false, legacyInstall: false, interrupt: false, auto: null, checked: false };
  if (!entry) {
    view.text = updateText("Checking status…");
    return view;
  }
  if (entry.error) {
    view.tone = "error";
    if (entry.error.remote) view.text = updatePhaseText(null, machine, entry.error);
    else if ([404, 405].includes(Number(entry.error.status))) view.text = updateText("Update controls need a newer Stepsemble on this device");
    else view.text = updateText("Can't reach this device");
    return view;
  }
  if (data?.updateUnsupported || !updater) {
    view.text = updateText("Update controls need a newer Stepsemble on this device");
    return view;
  }
  view.auto = { enabled: updater.enabled === true, available: updater.installed === true };
  const version = updateVersionText(latest);
  const checkedAt = updater.lastCheckedAt ? formatUpdateTime(updater.lastCheckedAt) : "";
  if (updater.activity === "installing" || updateInstallInFlight.has(machine.id)) {
    view.tone = "accent";
    view.text = latest && updateReleaseIsNewer(current, latest)
      ? updateText("Installing {version}…", { version })
      : updateText("Installing the latest release…");
    return view;
  }
  switch (updater.phase) {
    case "checking":
      view.text = updateText("Checking for updates…");
      break;
    case "deferred":
      view.tone = "warn";
      view.text = updateText("{version} installs when agent work finishes", { version });
      // A newer Host can install past the running work once the user confirms.
      view.interrupt = updater.interruptible === true && updater.installed === true;
      break;
    case "available":
      view.tone = "accent";
      view.checked = true;
      view.install = updater.installed === true;
      view.text = view.install
        ? updateText("{version} available", { version })
        : updateText("{version} available · the updater is not installed on this device", { version });
      break;
    case "error":
      view.tone = "error";
      view.text = updateText("Last check failed");
      break;
    case "unavailable":
      view.text = updateText("The updater is not installed on this device");
      break;
    case "disabled":
    case "idle":
      view.text = updateText("No check yet");
      break;
    default:
      view.tone = "ok";
      view.checked = true;
      view.text = checkedAt ? updateText("Up to date · checked {time}", { time: checkedAt }) : updateText("Up to date");
  }
  // Hosts older than the check-only API can only check by installing.
  view.legacyInstall = updater.checkOnly !== true && updater.installed === true && !view.install
    && !["checking", "deferred"].includes(updater.phase);
  return view;
}

function renderUpdateDeviceRow(machine) {
  const view = updateDeviceView(machine);
  const row = document.createElement("article");
  row.className = "update-device-row update-tone-" + view.tone;
  row.dataset.deviceId = machine.id;
  row.dataset.i18nIgnore = "true";

  const main = document.createElement("div");
  main.className = "update-device-main";
  const copy = document.createElement("div");
  copy.className = "update-device-copy";
  const title = document.createElement("div");
  title.className = "update-device-title";
  const name = document.createElement("strong");
  name.textContent = updateDeviceName(machine);
  title.appendChild(name);
  if (view.current) {
    const version = document.createElement("span");
    version.className = "update-device-version";
    version.textContent = updateVersionText(view.current);
    title.appendChild(version);
  }
  const status = document.createElement("small");
  status.className = "update-device-status";
  status.textContent = view.text;
  copy.append(title, status);
  main.appendChild(copy);

  if (view.install || view.legacyInstall || view.interrupt) {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "btn " + (view.install ? "primary" : "ghost") + " update-device-install";
    action.dataset.updateInstall = machine.id;
    action.textContent = view.install ? updateText("Install update") : view.interrupt ? updateText("Update now") : updateText("Install latest");
    action.disabled = updateInstallInFlight.has(machine.id) || updateInstallAllRunning;
    main.appendChild(action);
  }
  row.appendChild(main);

  if (view.auto) {
    const auto = document.createElement("label");
    auto.className = "update-device-auto";
    const label = document.createElement("span");
    label.textContent = view.auto.available
      ? updateText("Automatic updates")
      : updateText("Automatic updates need the Stepsemble updater");
    const toggle = document.createElement("span");
    toggle.className = "toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.dataset.updateAuto = machine.id;
    input.checked = view.auto.enabled;
    input.disabled = !view.auto.available || updateAutoInFlight.has(machine.id);
    input.setAttribute("aria-label", updateText("Automatic updates for {device}", { device: updateDeviceName(machine) }));
    const track = document.createElement("span");
    track.className = "toggle-track";
    toggle.append(input, track);
    auto.append(label, toggle);
    row.appendChild(auto);
  }
  return row;
}

function renderUpdateCenter() {
  if (el.updateCenterSummary) {
    const text = updateCenterSummaryText();
    el.updateCenterSummary.textContent = text;
    el.updateCenterSummary.classList.toggle("hidden", !text);
  }
  if (el.updateDeviceList) {
    el.updateDeviceList.innerHTML = "";
    for (const machine of machines) el.updateDeviceList.appendChild(renderUpdateDeviceRow(machine));
  }
  if (el.updateAllDevices) {
    el.updateAllDevices.textContent = machines.length > 1 ? updateText("Check all devices") : updateText("Check for updates");
    el.updateAllDevices.disabled = !!updateAllController || !machines.length;
  }
  if (el.updateInstallAll) {
    const installable = machines.filter((machine) => updateDeviceView(machine).install);
    el.updateInstallAll.classList.toggle("hidden", installable.length < 2);
    el.updateInstallAll.textContent = updateText("Install on {count} devices", { count: installable.length });
    el.updateInstallAll.disabled = updateInstallAllRunning || installable.some((machine) => updateInstallInFlight.has(machine.id));
  }
  renderHarnessUpdates(harnessUpdateDataByDevice.get(currentMachine()?.id) || null);
  renderSettingsNavigation();
}

// ---- Coding agent (harness) updates ----
function harnessVersionIsNewer(latest, current) {
  const parse = (value) => {
    const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1, 4).map(Number) : null;
  };
  const published = parse(latest);
  const installed = parse(current);
  if (!published || !installed) return false;
  for (let index = 0; index < 3; index += 1) {
    if (published[index] !== installed[index]) return published[index] > installed[index];
  }
  return false;
}

// Absence and host ownership are decided before freshness: a harness that is
// missing or updated elsewhere must never read as "Up to date".
function harnessUpdateKind(item) {
  if (!item) return "unchecked";
  if (item.installed === false || item.status === "not-installed") return "missing";
  if (item.updateMode === "manual" || item.status === "manual") return "manual";
  if (item.status === "available" || item.updateAvailable === true || harnessVersionIsNewer(item.latestVersion, item.currentVersion)) return "available";
  if (item.status === "error") return "error";
  if (item.status === "up-to-date" || item.status === "updated" || item.updateAvailable === false) return "current";
  if (item.status === "not-checked" || item.installed == null) return "unchecked";
  return "unknown";
}

function harnessUpdateStatusText(item) {
  if (harnessUpgradeBlocked(item)) return updateText("Update it where it was installed");
  switch (harnessUpdateKind(item)) {
    case "missing": return updateText("Not installed");
    case "manual": return updateText("Managed by host");
    case "available": return updateText("Update available");
    case "error": return updateText("Check failed");
    case "current": return updateText("Up to date");
    case "unchecked": return updateText("Not checked");
    default: return updateText("Can't check automatically");
  }
}

// A source-aware updater refuses an executable whose install source it cannot
// prove, so offering the button would only lead to a failure.
function harnessUpgradeBlocked(item) {
  return item?.updateMode === "source-aware" && item?.source === "unknown";
}

function harnessUpgradeable(item) {
  const kind = harnessUpdateKind(item);
  return item?.installed !== false && item?.updateMode !== "manual" && !harnessUpgradeBlocked(item)
    && (kind === "available" || kind === "unknown");
}

function formatUpdateAge(value) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (minutes < 1) return updateText("just now");
  if (minutes < 60) return updateText("{count} min ago", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return updateText("{count} h ago", { count: hours });
  return updateText("{count} d ago", { count: Math.round(hours / 24) });
}

function renderHarnessUpdates(data) {
  if (!el.harnessUpdateList || !el.harnessUpdateCheckAll || !el.harnessUpdateApplyAll) return;
  const machine = currentMachine();
  const device = updateDeviceName(machine);
  if (el.harnessUpdateTitle) el.harnessUpdateTitle.textContent = updateText("Coding agents");
  if (el.harnessUpdateNote) el.harnessUpdateNote.textContent = updateText("On {device}. Upgrades run only while no agent is working.", { device });
  el.harnessUpdateCheckAll.textContent = harnessCheckRunning ? updateText("Checking…") : updateText("Check now");
  el.harnessUpdateList.innerHTML = "";
  el.harnessUpdateMissing?.classList.add("hidden");
  const hideApplyAll = () => {
    el.harnessUpdateApplyAll.classList.add("hidden");
    el.harnessUpdateApplyAll.disabled = true;
  };
  if (!data) {
    if (el.harnessUpdateSummary) el.harnessUpdateSummary.textContent = updateText("Loading agent versions…");
    el.harnessUpdateCheckAll.disabled = true;
    hideApplyAll();
    return;
  }
  if (data.unsupported) {
    if (el.harnessUpdateSummary) el.harnessUpdateSummary.textContent = updateText("Agent updates need a newer Stepsemble on this device");
    el.harnessUpdateCheckAll.disabled = true;
    hideApplyAll();
    return;
  }
  if (data.error) {
    if (el.harnessUpdateSummary) el.harnessUpdateSummary.textContent = updateText("Agent versions are unavailable right now");
    el.harnessUpdateCheckAll.disabled = harnessCheckRunning;
    hideApplyAll();
    return;
  }
  const items = Array.isArray(data.harnesses) ? data.harnesses : [];
  const shown = items.filter((item) => harnessUpdateKind(item) !== "missing");
  const missing = items.filter((item) => harnessUpdateKind(item) === "missing");
  const outdated = shown.filter((item) => harnessUpdateKind(item) === "available" && harnessUpgradeable(item));
  const busy = data.busy === true || data.running === true;
  const parts = [];
  const installedCount = shown.filter((item) => item.installed === true).length;
  if (installedCount) parts.push(updateText("{count} installed", { count: installedCount }));
  parts.push(outdated.length
    ? updateText(outdated.length === 1 ? "1 update available" : "{count} updates available", { count: outdated.length })
    : updateText("No updates found"));
  parts.push(data.checkedAt ? updateText("checked {time}", { time: formatUpdateAge(data.checkedAt) }) : updateText("No check yet"));
  if (busy) parts.push(updateText("an agent is working"));
  if (el.harnessUpdateSummary) el.harnessUpdateSummary.textContent = harnessCheckRunning ? updateText("Checking agent versions…") : parts.join(" · ");
  el.harnessUpdateCheckAll.disabled = busy || harnessCheckRunning;
  el.harnessUpdateApplyAll.classList.toggle("hidden", outdated.length < 2);
  el.harnessUpdateApplyAll.textContent = updateText("Upgrade all ({count})", { count: outdated.length });
  el.harnessUpdateApplyAll.disabled = busy || harnessCheckRunning || harnessUpdateInFlight.size > 0 || outdated.length < 2;

  for (const item of shown) {
    const kind = harnessUpdateKind(item);
    const row = document.createElement("article");
    row.className = "harness-update-row harness-kind-" + kind;
    row.dataset.harnessId = item.id;
    row.dataset.i18nIgnore = "true";
    const copy = document.createElement("div");
    copy.className = "harness-update-copy";
    const name = document.createElement("strong");
    name.textContent = item.label || item.id;
    const detail = document.createElement("small");
    detail.className = "harness-update-version";
    const currentVersion = item.currentVersion ? updateVersionText(item.currentVersion) : "";
    if (kind === "available" && currentVersion && item.latestVersion) detail.textContent = currentVersion + " → " + updateVersionText(item.latestVersion);
    else if (kind === "unknown") detail.textContent = [currentVersion, updateText("Can't check automatically")].filter(Boolean).join(" · ");
    else if (kind !== "unchecked") detail.textContent = currentVersion || updateText("Version unavailable");
    copy.append(name);
    if (detail.textContent) copy.appendChild(detail);
    const notes = [];
    if (item.lastUpdateUnchanged) notes.push(updateText("The last upgrade did not change the installed version."));
    if (kind === "manual" && item.note) notes.push(item.note);
    // An unproven source refuses the update, so show which file was selected.
    if (item.executablePath && item.source === "unknown") notes.push(updateText("Selected executable: {path}", { path: item.executablePath }));
    for (const text of notes) {
      const note = document.createElement("p");
      note.className = "harness-update-note-inline";
      note.textContent = text;
      copy.appendChild(note);
    }
    row.appendChild(copy);
    if (harnessUpgradeable(item)) {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "btn " + (kind === "available" ? "primary" : "ghost") + " harness-update-action";
      action.dataset.harnessUpdateId = item.id;
      const running = harnessUpdateInFlight.has(item.id);
      action.textContent = running ? updateText("Upgrading…") : updateText("Upgrade");
      action.disabled = busy || running || harnessCheckRunning;
      row.appendChild(action);
    } else {
      const state = document.createElement("span");
      state.className = "harness-update-state";
      state.textContent = harnessUpdateStatusText(item);
      row.appendChild(state);
    }
    el.harnessUpdateList.appendChild(row);
  }
  if (el.harnessUpdateMissing && missing.length) {
    el.harnessUpdateMissing.textContent = updateText("Not installed: {names}", { names: missing.map((item) => item.label || item.id).join(", ") });
    el.harnessUpdateMissing.classList.remove("hidden");
  }
}

// Summary parts are stored as keys so a language switch re-renders them.
function setUpdateCenterSummary(key = "", vars = {}) {
  updateCenterSummary = key ? { parts: [[key, vars]] } : null;
  renderUpdateCenterSummary();
}

function setUpdateCenterSummaryParts(parts = []) {
  updateCenterSummary = parts.length ? { parts } : null;
  renderUpdateCenterSummary();
}

function updateCenterSummaryText() {
  if (!updateCenterSummary?.parts?.length) return "";
  return updateCenterSummary.parts.map(([key, vars]) => updateText(key, vars)).join(" · ");
}

function renderUpdateCenterSummary() {
  if (!el.updateCenterSummary) return;
  const text = updateCenterSummaryText();
  el.updateCenterSummary.textContent = text;
  el.updateCenterSummary.classList.toggle("hidden", !text);
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
      const [data, harness] = await Promise.all([
        fetchMachineUpdateStatus(machine, controller.signal),
        fetchMachineHarnessStatus(machine, controller.signal).catch((error) => ({ error, unsupported: false })),
      ]);
      return { id: machine.id, data, harness, reachable: true };
    } catch (error) {
      return { id: machine.id, error, reachable: !!error?.reachable || updateErrorIsUnsupported(error) };
    }
  })).then((results) => {
    if (controller.signal.aborted || request !== updateStatusRequest || generation !== viewGeneration
      || selectedAtStart !== selectedId || !updateViewIsOpen()) return null;
    const next = new Map();
    for (const result of results) {
      next.set(result.id, result);
      // A check that is still running owns the freshest agent data; a status
      // read taken halfway through it would show a partial list.
      if (!(harnessCheckRunning && result.id === currentMachine()?.id)) {
        if (result.harness) harnessUpdateDataByDevice.set(result.id, result.harness);
        else harnessUpdateDataByDevice.delete(result.id);
      }
      if (result.error) machineStatuses.set(result.id, result.reachable ? "online" : "offline");
      else machineStatuses.set(result.id, "online");
    }
    updateDeviceStatuses = next;
    updateStatusData = next.get(selectedId)?.data || null;
    renderUpdateCenter();
    maybeAutoCheckHarnesses();
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
  harnessUpdateRequest += 1;
  harnessUpdateController?.abort();
  harnessUpdateController = null;
  harnessCheckRunning = false;
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

// Agent versions are read when the Updates section is shown and the last
// check is old, so a stale "checked six days ago" answer is refreshed once.
const HARNESS_STALE_MS = 12 * 60 * 60 * 1000;
const harnessAutoChecked = new Set();
let harnessCheckRunning = false;

function maybeAutoCheckHarnesses() {
  const machine = currentMachine();
  if (!machine || !updateViewIsOpen() || activeSettingsCategory() !== "updates" || harnessCheckRunning) return;
  const data = harnessUpdateDataByDevice.get(machine.id);
  if (!data || data.unsupported || data.error || data.busy || data.running || harnessUpdateInFlight.size) return;
  if (harnessAutoChecked.has(machine.id)) return;
  const checked = Date.parse(String(data.checkedAt || ""));
  if (Number.isFinite(checked) && Date.now() - checked < HARNESS_STALE_MS) return;
  harnessAutoChecked.add(machine.id);
  void runHarnessCheckAll({ quiet: true });
}

// A single-harness check returns only that entry; merge it into the list.
function mergeHarnessStatus(previous, next) {
  if (!next || !Array.isArray(next.harnesses)) return next || previous;
  if (!previous || !Array.isArray(previous.harnesses) || next.harnesses.length >= previous.harnesses.length) return next;
  const replacements = new Map(next.harnesses.map((item) => [item.id, item]));
  return { ...previous, ...next, harnesses: previous.harnesses.map((item) => replacements.get(item.id) || item) };
}

async function runHarnessCheckAll({ quiet = false } = {}) {
  const machine = currentMachine();
  if (!machine || !el.harnessUpdateCheckAll || harnessCheckRunning) return;
  const generation = viewGeneration;
  const selectedAtStart = selectedId;
  harnessUpdateController?.abort();
  const controller = new AbortController();
  harnessUpdateController = controller;
  const request = ++harnessUpdateRequest;
  harnessCheckRunning = true;
  renderHarnessUpdates(harnessUpdateDataByDevice.get(machine.id) || null);
  const current = () => request === harnessUpdateRequest && generation === viewGeneration && selectedAtStart === selectedId && updateViewIsOpen();
  try {
    const result = await requestMachineUpdate(machine, "/api/harness-updates/check", {}, { signal: controller.signal, timeoutMs: 120_000 });
    if (!current()) return;
    harnessUpdateDataByDevice.set(machine.id, result.data);
    if (!quiet) toast(updateText("Agent versions checked"));
  } catch (error) {
    if (!current()) return;
    if ([404, 405].includes(Number(error?.status))) harnessUpdateDataByDevice.set(machine.id, { unsupported: true, harnesses: [] });
    if (!quiet) toast(updateText("Could not check agent versions"), true);
  } finally {
    if (harnessUpdateController === controller) harnessUpdateController = null;
    if (request === harnessUpdateRequest) harnessCheckRunning = false;
    if (current()) renderUpdateCenter();
  }
}

// Upgrading one harness re-reads its version afterwards, so a vendor updater
// that exits cleanly without installing the published release stays visible.
async function upgradeHarness(machine, item) {
  const id = item.id;
  harnessUpdateInFlight.add(id);
  renderHarnessUpdates(harnessUpdateDataByDevice.get(machine.id));
  try {
    const result = await requestMachineUpdate(machine, "/api/harness-updates/apply", { id, confirm: true }, { timeoutMs: 15 * 60 * 1000 });
    let data = result.data;
    try {
      const checked = await requestMachineUpdate(machine, "/api/harness-updates/check", { id }, { timeoutMs: 60_000 });
      data = mergeHarnessStatus(data, checked.data);
    } catch {}
    harnessUpdateDataByDevice.set(machine.id, data);
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error };
  } finally {
    harnessUpdateInFlight.delete(id);
  }
}

function harnessUpgradeResultText(machine, item, outcome) {
  const harness = item.label || item.id;
  if (outcome.ok) {
    const entry = (outcome.data?.harnesses || []).find((candidate) => candidate.id === item.id);
    return harnessUpdateKind(entry) === "available"
      ? updateText("{harness} upgrade finished, but a newer version is still available", { harness })
      : updateText("{harness} upgrade complete", { harness });
  }
  return Number(outcome.error?.status) === 409
    ? updateText("Active agent work must finish before upgrading {harness}", { harness })
    : updateText("Could not upgrade {harness}", { harness });
}

async function applyHarnessUpdate(id) {
  const machine = currentMachine();
  if (!machine || !id || harnessUpdateInFlight.has(id)) return;
  const item = (harnessUpdateDataByDevice.get(machine.id)?.harnesses || []).find(entry => entry.id === id) || { id, label: id };
  const harness = item.label || id;
  const target = item.latestVersion && harnessUpdateKind(item) === "available" ? updateVersionText(item.latestVersion) : "";
  const question = target
    ? updateText("Upgrade {harness} to {version} on {device}? Running agents are not interrupted; the upgrade is refused while one is working.", { harness, version: target, device: updateDeviceName(machine) })
    : updateText("Run the official updater for {harness} on {device}? Running agents are not interrupted; the upgrade is refused while one is working.", { harness, device: updateDeviceName(machine) });
  if (!confirm(question)) return;
  const generation = viewGeneration;
  const selectedAtStart = selectedId;
  const outcome = await upgradeHarness(machine, item);
  if (generation !== viewGeneration || selectedAtStart !== selectedId || !updateViewIsOpen()) return;
  renderUpdateCenter();
  const message = harnessUpgradeResultText(machine, item, outcome);
  toast(message, !outcome.ok);
}

async function applyAllHarnessUpdates() {
  const machine = currentMachine();
  if (!machine || !el.harnessUpdateApplyAll || harnessUpdateInFlight.size) return;
  const items = (harnessUpdateDataByDevice.get(machine.id)?.harnesses || [])
    .filter((item) => harnessUpdateKind(item) === "available" && harnessUpgradeable(item));
  if (!items.length) return;
  const lines = items.map((item) => "• " + (item.label || item.id) + (item.latestVersion ? " → " + updateVersionText(item.latestVersion) : "")).join("\n");
  if (!confirm(updateText("Upgrade these agents on {device}? Running agents are not interrupted; an upgrade is refused while one is working.", { device: updateDeviceName(machine) }) + "\n\n" + lines)) return;
  const generation = viewGeneration;
  const selectedAtStart = selectedId;
  let completed = 0;
  let failed = 0;
  for (const item of items) {
    const outcome = await upgradeHarness(machine, item);
    if (generation !== viewGeneration || selectedAtStart !== selectedId || !updateViewIsOpen()) return;
    if (outcome.ok) completed += 1;
    else failed += 1;
    renderHarnessUpdates(harnessUpdateDataByDevice.get(machine.id));
    if (!outcome.ok && Number(outcome.error?.status) === 409) break;
  }
  renderUpdateCenter();
  toast(updateText("Harness upgrades complete: {completed} updated, {failed} failed.", { completed, failed }), failed > 0);
}

// ---- Settings section list ----
function setSettingsSummary(element, value) {
  if (element && element.textContent !== value) element.textContent = value;
}

function updatesSectionSummary() {
  const views = machines.map((machine) => updateDeviceView(machine));
  const harness = harnessUpdateDataByDevice.get(currentMachine()?.id);
  const agentUpdates = Array.isArray(harness?.harnesses)
    ? harness.harnesses.filter((item) => harnessUpdateKind(item) === "available" && harnessUpgradeable(item)).length : 0;
  const appUpdates = views.filter((view) => view.install || view.tone === "warn" || (view.updater?.phase === "available")).length;
  const total = agentUpdates + appUpdates;
  if (total > 0) return { text: updateText(total === 1 ? "1 update available" : "{count} updates available", { count: total }), attention: true };
  if (views.length && views.every((view) => !view.entry) && !harness) return { text: updateText("Checking status…"), attention: false };
  if (views.some((view) => view.checked)) return { text: updateText("Up to date"), attention: false };
  return { text: updateText("Stepsemble and coding agents"), attention: false };
}

function renderSettingsNavigation() {
  const machine = currentMachine();
  const status = machineStatuses.get(machine?.id) || "unknown";
  if (el.setMachineName) el.setMachineName.textContent = machineDisplayName(machine) || machineDisplayName(currentHost) || "—";
  if (el.setMachineHost) el.setMachineHost.textContent = machineStatusText(status);
  if (el.settingsHostDot) el.settingsHostDot.className = "settings-host-dot machine-status-" + status;
  const theme = DESIGN_THEMES.find((item) => item.id === settings.designTheme)?.label || "";
  const language = window.stepsembleI18n?.locales?.find((item) => item.id === (settings.locale || "en"))?.label || "English";
  setSettingsSummary(el.settingsSummaryAppearance, [theme, language].filter(Boolean).join(" · "));
  setSettingsSummary(el.settingsSummaryDevices, updateText(machines.length === 1 ? "1 device" : "{count} devices", { count: machines.length }));
  const updates = updatesSectionSummary();
  setSettingsSummary(el.settingsSummaryUpdates, updates.text);
  el.settingsUpdatesBadge?.classList.toggle("hidden", !updates.attention);
  setSettingsSummary(el.settingsSummaryAbout, "Stepsemble v" + (window._appVersion || CLIENT_APP_VERSION));
  renderNotificationsSummary();
}

// The Notifications row in the section list shows whether this device gets alerts.
function renderNotificationsSummary() {
  const state = el.pushToggle?.dataset.pushState;
  const text = state === "on" ? tKey("notifications.summaryOn")
    : state === "enable" ? tKey("notifications.summaryOff")
      : state === "unsupported" ? updateText("Not available")
        : state === "denied" ? updateText("Blocked in browser settings") : null;
  if (text !== null) setSettingsSummary(el.settingsSummaryNotifications, text);
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

async function saveAutomaticUpdates(machineId, enabled) {
  const machine = machines.find((item) => item.id === machineId);
  if (!machine || updateAutoInFlight.has(machine.id)) return;
  const generation = viewGeneration;
  const device = updateDeviceName(machine);
  updateAutoInFlight.add(machine.id);
  renderUpdateCenter();
  try {
    const result = await requestMachineUpdate(machine, "/api/update/settings", { enabled });
    if (generation !== viewGeneration || !updateViewIsOpen()) return;
    const previous = updateDeviceStatuses.get(machine.id) || {};
    updateDeviceStatuses.set(machine.id, { ...previous, id: machine.id, data: result.data, reachable: true, error: undefined });
    if (machine.id === selectedId) updateStatusData = result.data;
    toast(updateText(enabled ? "Automatic updates enabled for {device}" : "Automatic updates disabled for {device}", { device }));
  } catch (error) {
    if (generation !== viewGeneration || !updateViewIsOpen()) return;
    toast(updateText("Could not save update settings on {device}", { device }), true);
  } finally {
    updateAutoInFlight.delete(machine.id);
    if (generation === viewGeneration && updateViewIsOpen()) renderUpdateCenter();
  }
}

// Checks every device for a newer release. A check never installs anything;
// Hosts that predate the check-only API are reported instead of being asked
// to run their updater.
async function runUpdateAll() {
  if (!el.updateAllDevices || updateAllController || !machines.length) return;
  const request = ++updateAllRequest;
  const generation = viewGeneration;
  const list = [...machines];
  const controller = new AbortController();
  cancelUpdateCenterRequest();
  updateAllController = controller;
  el.updateAllDevices.disabled = true;
  setUpdateCenterSummary(list.length === 1 ? "Checking for updates…" : "Checking {count} devices for updates…", { count: list.length });
  const counts = { checked: 0, available: 0, skipped: 0, failed: 0 };
  try {
    await Promise.all(list.map(async (machine) => {
      try {
        const result = await requestMachineUpdate(machine, "/api/update/check", {}, { signal: controller.signal, timeoutMs: 40_000 });
        counts.checked += 1;
        if (result.data?.updater?.phase === "available") counts.available += 1;
        const previous = updateDeviceStatuses.get(machine.id) || {};
        updateDeviceStatuses.set(machine.id, { ...previous, id: machine.id, data: result.data, reachable: true, error: undefined });
      } catch (error) {
        if (controller.signal.aborted) return;
        if ([404, 405].includes(Number(error?.status))) counts.skipped += 1;
        else counts.failed += 1;
      }
    }));
    if (request !== updateAllRequest || generation !== viewGeneration || !updateViewIsOpen()) return;
    const parts = [];
    if (counts.checked) {
      parts.push(counts.available
        ? [counts.available === 1 ? "1 device has an update" : "{available} devices have an update", counts]
        : [counts.checked === 1 ? "Up to date" : "All {checked} devices are up to date", counts]);
    }
    if (counts.skipped) parts.push(["{skipped} need a newer Stepsemble to check", counts]);
    if (counts.failed) parts.push(["{failed} could not be reached", counts]);
    setUpdateCenterSummaryParts(parts);
    renderUpdateCenter();
    await refreshUpdateCenter(true);
  } finally {
    if (updateAllController === controller) updateAllController = null;
    if (request === updateAllRequest && generation === viewGeneration && updateViewIsOpen()) {
      el.updateAllDevices.disabled = false;
      renderUpdateCenter();
    }
  }
}

// Lists what an immediate install would do to the work running on a device:
// which turns stop (the conversation stays and can be continued) and which
// supervised tasks keep running through the restart.
function updateInterruptQuestion(device, work, automatic) {
  const ordered = [...work.filter(item => item?.effect !== "continues"), ...work.filter(item => item?.effect === "continues")];
  const lines = ordered.slice(0, 8).map((item) => {
    // Settings may open before the connector catalog loads, so prefer the
    // built-in identity names over the raw connector id.
    const identity = item?.agent ? window.StepsembleAgentIdentity?.lookup?.(item.agent) : null;
    const agent = item?.agent ? (identity?.label && identity.id !== "agent" ? identity.label : agentConnectorLabel(item.agent)) : updateText("Agent work");
    const effect = item?.effect === "continues" ? updateText("keeps running") : updateText("stops; ask it to continue after the update");
    return "• " + agent + (item?.name ? " · " + item.name : "") + " — " + effect;
  });
  return [updateText("Update {device} now? Stepsemble restarts, which affects the work running there:", { device }), "", ...lines, "",
    updateText("Conversations are kept."), ...(automatic ? [updateText("If you cancel, it installs automatically when the work finishes.")] : [])].join("\n");
}

// Installing is always a separate, confirmed action per device. When agent
// work is running, the confirmation says what an immediate install interrupts.
async function installDeviceUpdate(machineId) {
  const machine = machines.find((item) => item.id === machineId);
  if (!machine || updateInstallInFlight.has(machine.id) || updateInstallAllRunning) return;
  const view = updateDeviceView(machine);
  const device = updateDeviceName(machine);
  const generation = viewGeneration;
  // Ask the device what is running now; the row may predate newly started work.
  let live = null;
  try { live = (await requestMachineUpdate(machine, "/api/update/status"))?.data?.updater || null; } catch {}
  if (generation !== viewGeneration || !updateViewIsOpen() || updateInstallInFlight.has(machine.id) || updateInstallAllRunning) return;
  const work = Array.isArray(live?.activeWork) ? live.activeWork : [];
  const interrupt = live?.interruptible === true && work.length > 0;
  const question = interrupt
    ? updateInterruptQuestion(device, work, live.enabled === true)
    : view.install || view.interrupt
      ? updateText("Install Stepsemble {version} on {device}? Stepsemble restarts after installing. If an agent is working, the install waits until it finishes.", { version: updateVersionText(view.latest), device })
      : updateText("{device} runs an older Stepsemble that can only check for updates by installing them. Install the latest release now?", { device });
  if (!confirm(question)) return;
  updateInstallInFlight.add(machine.id);
  renderUpdateCenter();
  try {
    await requestMachineUpdate(machine, "/api/update/run", interrupt ? { interrupt: true } : {});
    if (generation !== viewGeneration || !updateViewIsOpen()) return;
    toast(updateText("Installing Stepsemble on {device}…", { device }));
    scheduleUpdateRefreshes();
  } catch (error) {
    if (generation !== viewGeneration || !updateViewIsOpen()) return;
    toast(updateText("Could not start the update on {device}", { device }), true);
  } finally {
    // The Host reports its own progress from here; keep the row in its
    // installing state until the next status refresh replaces it.
    setTimeout(() => {
      updateInstallInFlight.delete(machine.id);
      if (updateViewIsOpen()) renderUpdateCenter();
    }, 2500);
  }
}

async function installAllDeviceUpdates() {
  if (updateInstallAllRunning) return;
  const targets = machines.filter((machine) => updateDeviceView(machine).install);
  if (!targets.length) return;
  const lines = targets.map((machine) => "• " + updateDeviceName(machine) + " → " + updateVersionText(updateDeviceView(machine).latest)).join("\n");
  if (!confirm(updateText("Install Stepsemble updates on these devices? Each device restarts Stepsemble after installing and waits for running agent work first.") + "\n\n" + lines)) return;
  const generation = viewGeneration;
  updateInstallAllRunning = true;
  for (const machine of targets) updateInstallInFlight.add(machine.id);
  renderUpdateCenter();
  const counts = { started: 0, failed: 0 };
  try {
    await Promise.all(targets.map(async (machine) => {
      try {
        await requestMachineUpdate(machine, "/api/update/run", {});
        counts.started += 1;
      } catch {
        counts.failed += 1;
      }
    }));
    if (generation !== viewGeneration || !updateViewIsOpen()) return;
    setUpdateCenterSummaryParts([
      ["Installing on {started} devices", counts],
      ...(counts.failed ? [["{failed} could not start", counts]] : []),
    ]);
    scheduleUpdateRefreshes();
  } finally {
    updateInstallAllRunning = false;
    setTimeout(() => {
      for (const machine of targets) updateInstallInFlight.delete(machine.id);
      if (updateViewIsOpen()) renderUpdateCenter();
    }, 2500);
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
  if (el.setAppVersion) el.setAppVersion.textContent = `v${window._appVersion || CLIENT_APP_VERSION}`;
  if (el.setLocale) el.setLocale.value = settings.locale || "en";
  el.setTheme.value = settings.theme;
  renderThemeChoices();
  if (el.setSidebarWidth) el.setSidebarWidth.value = settings.sidebarWidth;
  if (el.setSidebarWidthValue) el.setSidebarWidthValue.textContent = `${settings.sidebarWidth}px`;
  if (el.setFontScale) el.setFontScale.value = settings.fontScale;
  if (el.setFontScaleValue) el.setFontScaleValue.textContent = `${settings.fontScale}%`;
  el.setCompact.checked = !!settings.compact;
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
  applySettingsCategory();
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

function piModelSummaryText() {
  if (modelCatalogLoading && modelCatalogMachine == null) return "";
  const providers = new Set(modelCatalog.map((model) => model?.provider || "unknown"));
  const modelKeys = new Set(modelCatalog.map((model) => `${model?.provider || "unknown"}::${model?.id || ""}`));
  for (const provider of configuredProviders) {
    providers.add(provider.id);
    for (const model of provider.models || []) modelKeys.add(`${provider.id}::${model.id}`);
  }
  const suffix = modelProviderError ? " · 設定需檢查" : "";
  return providers.size || modelKeys.size ? `${providers.size} Provider · ${modelKeys.size} 模型${suffix}` : "";
}

let modelSettingsSummaryBase;
function renderModelSettingsSummary() {
  if (!el.modelSettingsSummary) return;
  const catalog = agentAuthCatalogState.base === apiBase ? agentAuthCatalogState.data : null;
  const names = catalog ? modelSettingsAgentIds().filter(id => catalog.agents?.[id]?.installed).map(agentTerminalLabel) : [];
  el.modelSettingsSummary.textContent = names.length
    ? (names.length > 4 ? names.slice(0, 4).join(", ") + " +" + (names.length - 4) : names.join(", "))
    : modelAgentText("rowSummary");
  // Load the agent list once per host, then name the agents in the row.
  if (!catalog && modelSettingsSummaryBase !== apiBase) {
    modelSettingsSummaryBase = apiBase;
    loadAgentAuthCatalog().then(() => { if (agentAuthCatalogState.base === apiBase && agentAuthCatalogState.data) renderModelSettingsSummary(); }).catch(() => {});
  }
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
    const source = modelCatalogSources.get(provider);
    const sourceNote = document.createElement("span");
    sourceNote.dataset.i18nIgnore = "";
    const sourceKey = source?.source === "provider-api" ? "official" : source?.source === "pi-directory" ? "pi"
      : providerConfig ? "manual" : "unknown";
    sourceNote.textContent = tKey("catalogSource." + sourceKey)
      + (source?.checkedAt ? " · " + new Date(source.checkedAt).toLocaleTimeString() : "")
      + (source?.stale ? " · " + tKey("catalogSource.cached") : "");
    if (source?.stale) sourceNote.classList.add("error-text");
    headingCopy.appendChild(sourceNote);
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
      name.dataset.i18nIgnore = "true";
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
  setProviderFormError();
}

// Custom providers are Pi's models.json entries for self-hosted or other
// OpenAI-compatible endpoints. Services Pi can sign in to are added with
// /login in a Pi conversation instead.
function openProviderDialog(provider = null) {
  providerDialogMode = provider ? "edit" : "add";
  providerDialogExisting = provider;
  if (el.providerDialogTitle) el.providerDialogTitle.textContent = provider ? tKey("provider.editTitle", { id: provider.id }) : tKey("provider.customTitle");
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
  setProviderFormError();
  el.providerDialog?.classList.remove("hidden");
  setTimeout(() => el.providerId?.focus(), 0);
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
  if (!force && modelCatalogMachine === machine && Date.now() - modelCatalogLoadedAt < 60_000) {
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
    // Settings describe host-wide provider configuration; a session may have
    // its own extensions and a stale snapshot and is not the catalog owner.
    const sid = "";
    const [modelsResult, providersResult] = await Promise.allSettled([
      api("/api/models" + sid, { signal: request.signal }),
      api("/api/model-providers", { signal: request.signal }),
    ]);
    if (request.signal.aborted || generation !== viewGeneration || baseAtStart !== apiBase) return;
    if (modelsResult.status === "rejected") throw modelsResult.reason;
    modelCatalog = Array.isArray(modelsResult.value?.models) ? modelsResult.value.models : [];
    modelCatalogSources = new Map((modelsResult.value?.catalog?.refreshed || []).map(source => [source.id, source]));
    const catalogStatus = $("model-catalog-status");
    if (catalogStatus) {
      delete catalogStatus.dataset.i18nKey;
      const status = modelsResult.value?.catalog;
      const failures = status?.errors?.length || 0;
      catalogStatus.textContent = failures ? tKey("modelsCheck.failed", { count: failures })
        : status?.checkedAt ? `${tKey("modelsCheck.auto")} · ${new Date(status.checkedAt).toLocaleTimeString()}`
          : tKey("modelsCheck.auto");
      catalogStatus.classList.toggle("error-text", failures > 0);
    }
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
    modelCatalogLoadedAt = Date.now();
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

el.modelVisibilityRefresh?.addEventListener("click", () => {
  const agent = currentModelSettingsAgent();
  if (agent === "pi") void loadModelVisibility(true);
  else if (agent === "opencode") void loadOpenCodeProviders(true);
  else if (agent) { if (isRoutedModelAgent(agent)) void loadCodexGateway(true); void loadAgentModelList(agent); }
  else void renderModelAgentList();
});

el.modelCatalogRefresh?.addEventListener("click", async () => {
  const button = el.modelCatalogRefresh;
  button.disabled = true;
  try {
    const result = await post("/api/model-catalog-refresh");
    const changed = Array.isArray(result?.refreshed) ? result.refreshed.filter((item) => item?.changed).length : 0;
    const failed = Array.isArray(result?.errors) ? result.errors.length : 0;
    // Force a global (not session-scoped) reload so the refreshed pi.dev
    // overlay from models-store.json is what renders, even inside a chat.
    await loadModelVisibility(true, true);
    if (failed) toast(tKey("modelsCheck.failed", { count: failed }));
    else if (changed) toast(tKey("modelsCheck.updated", { count: changed }));
    else if (result?.skipped || !result?.refreshed?.some(item => item.supported !== false)) toast(tKey("modelsCheck.unavailable"));
    else toast(tKey("modelsCheck.current"));
  } catch (e) {
    toast(tKey("modelsCheck.requestFailed", { detail: e?.message || "" }));
  } finally {
    button.disabled = false;
  }
});

// ===========================================================================
// OpenCode providers (models & providers page, OpenCode tab)
// ===========================================================================

let modelSettingsAgent = null;
let openCodeCatalogData = null;
let openCodeCatalogLoading = false;
let openCodeCatalogRequest = null;
let openCodeDialogEdit = null;

// Models & providers lists every agent installed on the host. Each agent's page
// says how to sign in and shows the models it offers and its own settings:
// Pi's visible models and custom providers, OpenCode's providers and local
// server, and the OpenCodex routing for Codex and Claude Code.
function modelSettingsAgentIds() { return ["pi", "codex", "claude-code", "opencode", "kilo", "hermes", "grok-build", "cline", "antigravity"]; }
function isRoutedModelAgent(agent) { return agent === "codex" || agent === "claude-code"; }
function currentModelSettingsAgent() { return modelSettingsAgent; }
function modelAgentText(key, vars = {}) { return tKey("modelAgents." + key, vars); }

function setModelSettingsAgent(agent, { sync = true } = {}) {
  modelSettingsAgent = modelSettingsAgentIds().includes(agent) ? agent : null;
  applyModelSettingsAgent();
  const scroll = el.viewModelSettings?.querySelector(".settings-scroll");
  if (scroll) scroll.scrollTop = 0;
  if (sync) syncSettingsNav();
}

function applyModelSettingsAgent() {
  const agent = modelSettingsAgent;
  const pi = agent === "pi", opencode = agent === "opencode", routed = isRoutedModelAgent(agent);
  const listed = !!agent && !pi && !opencode;
  const title = agent ? agentTerminalLabel(agent) : updateText("Models & providers");
  if (el.modelSettingsTopbarTitle) el.modelSettingsTopbarTitle.textContent = title;
  if (el.modelSettingsHeading) el.modelSettingsHeading.textContent = title;
  el.modelSettingsIntro?.classList.toggle("hidden", !!agent);
  el.modelAgentList?.classList.toggle("hidden", !!agent);
  el.modelAgentSignin?.classList.toggle("hidden", !agent);
  if (agent && el.modelAgentSigninText) el.modelAgentSigninText.textContent = modelAgentText("signIn", { agent: title });
  // Pi's own controls: import/export, the pi.dev catalog refresh and its list.
  el.providerConfigImport?.classList.toggle("hidden", !pi);
  el.providerConfigExport?.classList.toggle("hidden", !pi);
  el.providerAdd?.classList.toggle("hidden", !(pi || opencode));
  el.modelCatalogRefresh?.classList.toggle("hidden", !pi);
  el.modelVisibilityRefresh?.classList.toggle("hidden", !agent);
  $("model-catalog-status")?.classList.toggle("hidden", !pi);
  el.modelListToolbar?.classList.toggle("hidden", !pi);
  el.modelVisibilityList?.classList.toggle("hidden", !pi);
  el.opencodeProviderPanel?.classList.toggle("hidden", !opencode);
  el.codexGatewayPanel?.classList.toggle("hidden", !codexGatewayVisible());
  el.agentModelPanel?.classList.toggle("hidden", !listed);
  // Usage is read from Pi's own session files, so it belongs on Pi's page.
  el.piUsagePanel?.classList.toggle("hidden", !pi);
  el.claudeHelperPanel?.classList.add("hidden");
  if (!agent) { void renderModelAgentList(); return; }
  if (pi) { void loadModelVisibility(); void renderUsageSummary(); }
  if (opencode) void loadOpenCodeProviders();
  if (routed) { renderCodexGateway(); void loadCodexGateway(); }
  if (listed) void loadAgentModelList(agent);
  if (agent === "claude-code") void renderClaudeHelperPanel();
}

// Claude Code on a Mac can start through Stepsemble's desktop helper, which
// only changes when the person updates it. An earlier helper cannot sign in
// from conversations or offer Bypass permissions, so its page offers the update.
let claudeHelperRequest = 0;
async function renderClaudeHelperPanel({ note = "" } = {}) {
  const panel = el.claudeHelperPanel;
  if (!panel || !el.claudeHelperText || !el.claudeHelperUpdate) return;
  const sequence = ++claudeHelperRequest, base = apiBase;
  let entry = null;
  try { entry = (await loadAgentAuthCatalog())?.agents?.["claude-code"] || null; } catch {}
  if (sequence !== claudeHelperRequest || base !== apiBase || modelSettingsAgent !== "claude-code") return;
  const desktop = entry?.desktop === true;
  panel.classList.toggle("hidden", !desktop);
  if (!desktop) return;
  const current = entry.terminal === true && entry.bypass === true;
  const host = agentTerminalHostName(base);
  el.claudeHelperText.textContent = note || modelAgentText(current ? "helperCurrent" : "helperOutdated", { host });
  el.claudeHelperUpdate.textContent = agentTerminalText("updateHelper");
  el.claudeHelperUpdate.title = agentTerminalText("updateHelperHint");
  el.claudeHelperUpdate.classList.toggle("hidden", current);
  el.claudeHelperUpdate.disabled = false;
}
el.claudeHelperUpdate?.addEventListener("click", async () => {
  const base = apiBase, host = agentTerminalHostName(base);
  el.claudeHelperUpdate.disabled = true;
  el.claudeHelperText.textContent = agentTerminalText("helperUpdating");
  let note;
  try {
    await post("/api/claude/desktop/upgrade", { confirm: true });
    note = agentTerminalText("helperUpdated");
  } catch (error) {
    const code = String(error?.code || error?.message || "");
    note = code === "active_tasks" ? modelAgentText("helperBusy", { host })
      : agentTerminalText("helperUpdateFailed", { detail: error?.message || code || "unknown error" });
  }
  if (base !== apiBase) return;
  agentAuthCatalogState = { base: null, at: 0, data: null, request: null };
  await renderClaudeHelperPanel({ note });
});

function modelAgentSummary(id, catalog = null) {
  if (id === "pi") return piModelSummaryText() || modelAgentText("summary.pi");
  // OpenCodex routing is mentioned only where the host has OpenCodex.
  if (isRoutedModelAgent(id)) return modelAgentText(catalog?.opencodex === false ? "summary.models" : "summary.routed");
  if (id === "opencode") return modelAgentText("summary.opencode");
  return modelAgentText("summary.models");
}

let modelAgentListRequest = 0;
async function renderModelAgentList() {
  const box = el.modelAgentList;
  if (!box) return;
  const sequence = ++modelAgentListRequest, base = apiBase;
  let catalog = null;
  try { catalog = await loadAgentAuthCatalog(); } catch {}
  if (sequence !== modelAgentListRequest || base !== apiBase || modelSettingsAgent) return;
  const installed = modelSettingsAgentIds().filter(id => catalog ? catalog.agents?.[id]?.installed : id === "pi");
  box.replaceChildren();
  if (!installed.length) {
    const empty = document.createElement("p");
    empty.className = "settings-note model-agent-list-empty";
    empty.textContent = modelAgentText("none");
    box.appendChild(empty);
    return;
  }
  for (const id of installed) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "settings-navigation-row";
    row.dataset.modelAgent = id;
    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = agentTerminalLabel(id);
    const detail = document.createElement("small");
    detail.textContent = modelAgentSummary(id, catalog);
    copy.append(name, detail);
    const chevron = document.createElement("span");
    chevron.className = "row-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = "→";
    row.append(copy, chevron);
    row.addEventListener("click", () => setModelSettingsAgent(id));
    box.appendChild(row);
  }
}

// Codex lists its models live. Claude Code and the ACP agents only report them
// inside a conversation, so their page shows the list from the last one.
let agentModelRequest = 0;
async function loadAgentModelList(agentId) {
  const box = el.agentModelList, status = el.agentModelStatus;
  if (!box || !status) return;
  const sequence = ++agentModelRequest, base = apiBase;
  const current = () => sequence === agentModelRequest && base === apiBase && modelSettingsAgent === agentId;
  box.replaceChildren();
  status.textContent = modelAgentText("loading");
  status.classList.remove("hidden");
  try {
    let models = [], observedAt = null, supported = true;
    if (agentId === "codex") {
      let cursor = null;
      for (let page = 0; page < 32; page += 1) {
        const result = await api("/api/codex/models" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""));
        if (!current()) return;
        models.push(...(Array.isArray(result?.data) ? result.data : []).map(normalizeCodexModel).filter(Boolean));
        const next = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
        if (!next || next === cursor) break;
        cursor = next;
      }
    } else {
      const result = await api("/api/agent-models?agentId=" + encodeURIComponent(agentId));
      if (!current()) return;
      models = Array.isArray(result?.models) ? result.models : [];
      observedAt = Number.isFinite(result?.observedAt) ? result.observedAt : null;
      supported = result?.supported !== false;
    }
    if (!current()) return;
    const label = agentTerminalLabel(agentId);
    for (const model of models) {
      const row = document.createElement("div");
      row.className = "agent-model-row";
      const name = document.createElement("strong");
      name.textContent = model.name || model.id;
      row.appendChild(name);
      const detail = [model.name && model.name !== model.id ? model.id : "", model.description || ""].filter(Boolean).join(" · ");
      if (detail) {
        const small = document.createElement("small");
        small.textContent = detail;
        row.appendChild(small);
      }
      box.appendChild(row);
    }
    status.textContent = !supported ? modelAgentText("unsupported", { agent: label })
      : !models.length ? modelAgentText("empty", { agent: label })
        : observedAt ? modelAgentText("seen", { time: new Date(observedAt).toLocaleString(document.documentElement.lang || undefined) }) : "";
    status.classList.toggle("hidden", !status.textContent);
  } catch (error) {
    if (!current()) return;
    status.textContent = modelAgentText("failed", { detail: String(error?.message || "unknown error").slice(0, 160) });
  }
}

el.modelAgentStatus?.addEventListener("click", () => {
  if (modelSettingsAgent) void openAgentTerminal({ agentId: modelSettingsAgent, action: "status" });
});

function openCodeModelLine(model) {
  const id = String(model?.id || model?.modelID || "").trim();
  if (!id) return "";
  const name = String(model?.name || "").trim();
  const reasoning = model?.reasoning === true;
  return [id, name, reasoning ? "reasoning" : ""].filter(Boolean).join(" | ");
}

async function loadOpenCodeProviders(force = false) {
  if (!el.opencodeProviderList) return;
  if (openCodeCatalogLoading && !force) return;
  if (openCodeCatalogRequest) openCodeCatalogRequest.abort();
  const generation = viewGeneration;
  const baseAtStart = apiBase;
  openCodeCatalogLoading = true;
  const request = new AbortController();
  openCodeCatalogRequest = request;
  if (el.opencodeProviderStatus) {
    el.opencodeProviderStatus.textContent = "Loading OpenCode providers…";
    el.opencodeProviderStatus.classList.remove("hidden");
  }
  try {
    const result = await api("/api/opencode/provider-catalog", { signal: request.signal });
    if (request.signal.aborted || generation !== viewGeneration || baseAtStart !== apiBase) return;
    openCodeCatalogData = result;
    renderOpenCodeProviders();
  } catch (e) {
    if (e.name === "AbortError") return;
    if (generation === viewGeneration && baseAtStart !== apiBase) {
      openCodeCatalogData = null;
      if (el.opencodeProviderList) el.opencodeProviderList.innerHTML = "";
      if (el.opencodeProviderStatus) {
        el.opencodeProviderStatus.textContent = `OpenCode providers unavailable: ${e.message || "unknown error"}`;
      }
    }
  } finally {
    if (openCodeCatalogRequest === request) {
      openCodeCatalogLoading = false;
      openCodeCatalogRequest = null;
    }
  }
}

function openCodeModelSummary(models) {
  const list = Array.isArray(models) ? models : [];
  if (!list.length) return "No models";
  const names = list.slice(0, 3).map(model => String(model?.id || model?.modelID || "")).filter(Boolean);
  return `${list.length} models${names.length ? ` · ${names.join(", ")}${list.length > names.length ? "…" : ""}` : ""}`;
}

function renderOpenCodeProviders() {
  const data = openCodeCatalogData;
  if (!el.opencodeProviderList) return;
  el.opencodeProviderList.innerHTML = "";
  if (!data) return;
  const runtime = Array.isArray(data.runtime?.providers) ? data.runtime.providers : [];
  const custom = Array.isArray(data.providers) ? data.providers : [];
  const auth = Array.isArray(data.auth) ? data.auth : [];
  if (el.opencodeProviderStatus) {
    const runtimeError = data.runtime?.error;
    el.opencodeProviderStatus.textContent = runtimeError
      ? `OpenCode server is not reachable (${runtimeError}); showing saved custom providers.`
      : `OpenCode server reports ${runtime.length} active provider${runtime.length === 1 ? "" : "s"} · ${custom.length} custom`;
  }

  const section = (title) => {
    const heading = document.createElement("p");
    heading.className = "opencode-provider-section";
    heading.textContent = title;
    el.opencodeProviderList.appendChild(heading);
  };

  const modelChips = (models, limit = 6) => {
    const chips = document.createElement("div");
    chips.className = "opencode-provider-models";
    for (const model of (Array.isArray(models) ? models : []).slice(0, limit)) {
      const chip = document.createElement("span");
      chip.className = "opencode-provider-model";
      chip.textContent = String(model?.id || model?.modelID || "");
      chips.appendChild(chip);
    }
    const extra = (Array.isArray(models) ? models.length : 0) - Math.min(limit, Array.isArray(models) ? models.length : 0);
    if (extra > 0) {
      const more = document.createElement("span");
      more.className = "opencode-provider-more";
      more.textContent = `+${extra} more`;
      chips.appendChild(more);
    }
    return chips;
  };

  const card = ({ title, subtitle, actions, models }) => {
    const node = document.createElement("div");
    node.className = "opencode-provider-card";
    const head = document.createElement("div");
    head.className = "opencode-provider-card-head";
    const copy = document.createElement("div");
    copy.className = "opencode-provider-copy";
    const strong = document.createElement("strong");
    strong.textContent = title;
    copy.appendChild(strong);
    if (subtitle) {
      const small = document.createElement("small");
      small.textContent = subtitle;
      copy.appendChild(small);
    }
    head.appendChild(copy);
    if (actions) {
      const bar = document.createElement("div");
      bar.className = "opencode-provider-actions";
      for (const action of actions) bar.appendChild(action);
      head.appendChild(bar);
    }
    node.appendChild(head);
    if (models) node.appendChild(models);
    return node;
  };

  const smallButton = (label, onClick, kind = "ghost") => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `btn ${kind} provider-row-action`;
    button.textContent = label;
    button.addEventListener("click", onClick);
    return button;
  };

  if (data.jsoncConflict) {
    const warn = document.createElement("p");
    warn.className = "settings-note error-text";
    warn.textContent = "opencode.jsonc also defines providers; OpenCode may override the entries edited here.";
    el.opencodeProviderList.appendChild(warn);
  }

  if (runtime.length) {
    section("Signed in & built in");
    for (const provider of runtime) {
      el.opencodeProviderList.appendChild(card({
        title: provider.name || provider.id,
        subtitle: `${provider.id} · ${openCodeModelSummary(provider.models)}`,
        models: modelChips(provider.models),
      }));
    }
  }

  section("Custom (opencode.json)");
  if (custom.length) {
    for (const provider of custom) {
      el.opencodeProviderList.appendChild(card({
        title: provider.name || provider.id,
        subtitle: `${provider.id} · ${provider.baseURL || ""}${provider.hasApiKey ? " · API key saved" : " · no API key"}`,
        models: modelChips(provider.models),
        actions: [
          smallButton("Edit", () => openOpenCodeProviderDialog(provider)),
          smallButton("Delete", () => deleteOpenCodeProvider(provider), "danger-text"),
        ],
      }));
    }
  } else {
    const empty = document.createElement("p");
    empty.className = "settings-note model-visibility-empty";
    empty.textContent = "No custom providers yet. Add one to route OpenCode sessions to any OpenAI-compatible endpoint.";
    el.opencodeProviderList.appendChild(empty);
  }
}

function openOpenCodeProviderDialog(provider = null) {
  openCodeDialogEdit = provider;
  if (el.opencodeProviderDialogTitle) el.opencodeProviderDialogTitle.textContent = provider ? `Edit ${provider.id}` : "Add OpenCode provider";
  if (el.opencodeProviderId) {
    el.opencodeProviderId.value = provider?.id || "";
    el.opencodeProviderId.readOnly = !!provider;
  }
  if (el.opencodeProviderName) el.opencodeProviderName.value = provider?.name || "";
  if (el.opencodeProviderBaseUrl) el.opencodeProviderBaseUrl.value = provider?.baseURL || "";
  if (el.opencodeProviderApiKey) {
    el.opencodeProviderApiKey.value = "";
    el.opencodeProviderApiKey.placeholder = provider?.hasApiKey ? "Leave empty to keep the stored key" : "sk-…";
  }
  if (el.opencodeProviderModels) {
    el.opencodeProviderModels.value = (Array.isArray(provider?.models) ? provider.models : [])
      .map(model => [String(model?.id || ""), String(model?.name || ""), model?.reasoning === true ? "reasoning" : ""].filter(Boolean).join(" | "))
      .join("\n");
  }
  if (el.opencodeProviderDelete) el.opencodeProviderDelete.classList.toggle("hidden", !provider);
  setOpencodeProviderError();
  el.opencodeProviderDialog?.classList.remove("hidden");
  if (!provider) setTimeout(() => el.opencodeProviderId?.focus(), 0);
}

function closeOpenCodeProviderDialog() {
  openCodeDialogEdit = null;
  el.opencodeProviderDialog?.classList.add("hidden");
  setOpencodeProviderError();
}

function setOpencodeProviderError(message = "") {
  if (!el.opencodeProviderFormError) return;
  el.opencodeProviderFormError.textContent = message;
  el.opencodeProviderFormError.classList.toggle("hidden", !message);
}

async function saveOpenCodeProvider() {
  const id = String(el.opencodeProviderId?.value || "").trim();
  const name = String(el.opencodeProviderName?.value || "").trim();
  const baseURL = String(el.opencodeProviderBaseUrl?.value || "").trim();
  const apiKey = String(el.opencodeProviderApiKey?.value || "").trim();
  const models = parseProviderModels(el.opencodeProviderModels?.value);
  if (!id || !baseURL || !models.length) {
    setOpencodeProviderError("Provider ID, base URL, and at least one model are required.");
    return;
  }
  if (el.opencodeProviderSave) el.opencodeProviderSave.disabled = true;
  setOpencodeProviderError();
  try {
    const body = { action: "save", id, models };
    if (name) body.name = name;
    body.baseURL = baseURL;
    if (apiKey) body.apiKey = apiKey;
    await post("/api/opencode/providers", body);
    const wasEdit = !!openCodeDialogEdit;
    closeOpenCodeProviderDialog();
    toast(wasEdit ? "Provider updated" : "Provider added");
    await loadOpenCodeProviders(true);
  } catch (e) {
    setOpencodeProviderError(e.message || "Save failed");
  } finally {
    if (el.opencodeProviderSave) el.opencodeProviderSave.disabled = false;
  }
}

async function deleteOpenCodeProvider(provider) {
  if (!provider?.id || !window.confirm(`Remove provider "${provider.id}" from opencode.json?`)) return;
  try {
    await post("/api/opencode/providers", { action: "delete", id: provider.id });
    closeOpenCodeProviderDialog();
    toast("Provider deleted");
    await loadOpenCodeProviders(true);
  } catch (e) {
    toast(e.message || "Delete failed");
  }
}

el.opencodeProviderSave?.addEventListener("click", saveOpenCodeProvider);
el.opencodeProviderDelete?.addEventListener("click", () => deleteOpenCodeProvider(openCodeDialogEdit));
el.opencodeProviderCancel?.addEventListener("click", closeOpenCodeProviderDialog);
el.opencodeProviderCancelBottom?.addEventListener("click", closeOpenCodeProviderDialog);

// ===========================================================================
// Codex & Claude gateway panel (OpenCodex integration)
// ===========================================================================

let codexGatewayData = null;
// The host codexGatewayData came from; another host's cards are never shown.
let codexGatewayBase = null;
let codexGatewayLoading = false;
let codexGatewayRequest = null;
let codexGatewayRequestBase = null;

function gatewayText(key, vars = {}) { return tKey("gateway." + key, vars); }

// The OpenCodex cards appear once the selected host says OpenCodex is there.
// A host from before that field keeps showing them.
function codexGatewayVisible() {
  return isRoutedModelAgent(modelSettingsAgent) && codexGatewayBase === apiBase
    && !!codexGatewayData && codexGatewayData.installed !== false;
}

async function loadCodexGateway(force = false) {
  if (!el.codexGatewayList) return;
  if (codexGatewayLoading && !force && codexGatewayRequestBase === apiBase) return;
  if (codexGatewayRequest) codexGatewayRequest.abort();
  const generation = viewGeneration;
  const baseAtStart = apiBase;
  codexGatewayLoading = true;
  const request = new AbortController();
  codexGatewayRequest = request;
  codexGatewayRequestBase = baseAtStart;
  if (el.codexGatewayStatus) {
    el.codexGatewayStatus.textContent = gatewayText("checking");
    el.codexGatewayStatus.classList.remove("hidden");
  }
  try {
    const result = await api("/api/gateway/status", { signal: request.signal });
    if (request.signal.aborted || generation !== viewGeneration || baseAtStart !== apiBase) return;
    codexGatewayData = result;
    codexGatewayBase = baseAtStart;
    el.codexGatewayStatus?.classList.add("hidden");
    renderCodexGateway();
  } catch (e) {
    if (e.name === "AbortError") return;
    // Only an answer about the host on screen may change what it shows.
    if (generation === viewGeneration && baseAtStart === apiBase) {
      el.codexGatewayList.replaceChildren();
      if (el.codexGatewayStatus) el.codexGatewayStatus.textContent = gatewayText("unavailable", { detail: e.message || "unknown error" });
    }
  } finally {
    if (codexGatewayRequest === request) {
      codexGatewayLoading = false;
      codexGatewayRequest = null;
      codexGatewayRequestBase = null;
    }
  }
}

function codexGatewayChip(label, kind) {
  const chip = document.createElement("span");
  chip.className = "gateway-badge" + (kind ? " gateway-badge-" + kind : "");
  chip.textContent = label;
  return chip;
}

function codexGatewayCard(title, detail, chip = null) {
  const card = document.createElement("div");
  card.className = "opencode-provider-card";
  const head = document.createElement("div");
  head.className = "gateway-row";
  const copy = document.createElement("div");
  copy.className = "opencode-provider-copy";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const small = document.createElement("small");
  small.textContent = detail;
  copy.append(strong, small);
  head.appendChild(copy);
  if (chip) head.appendChild(codexGatewayChip(chip.label, chip.kind));
  card.appendChild(head);
  return card;
}

function codexGatewayNote(value) {
  const note = document.createElement("p");
  note.className = "settings-note";
  note.textContent = value;
  return note;
}

function gatewayActionError(error) {
  const code = String(error?.code || "");
  if (code === "opencodex_missing") return gatewayText("error.missing");
  if (code === "claude_routing_disabled_in_gateway") return gatewayText("error.claudeOff");
  return gatewayText("error.failed", { detail: error?.message || code || "unknown error" });
}

// A switch that asks first, runs OpenCodex's own command on the host and then
// reads the state back.
function codexGatewayAction(label, question, body) {
  const actions = document.createElement("div");
  actions.className = "opencode-provider-actions gateway-actions";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn ghost provider-row-action";
  button.textContent = label;
  button.addEventListener("click", async () => {
    if (!window.confirm(question)) return;
    button.disabled = true;
    try {
      await post("/api/gateway/action", body);
      await loadCodexGateway(true);
    } catch (error) {
      toast(gatewayActionError(error), true);
    } finally {
      button.disabled = false;
    }
  });
  actions.appendChild(button);
  return actions;
}

function renderCodexGateway() {
  if (!el.codexGatewayList) return;
  const visible = codexGatewayVisible();
  el.codexGatewayPanel?.classList.toggle("hidden", !visible);
  el.codexGatewayList.replaceChildren();
  if (!visible) return;
  const data = codexGatewayData;

  const providers = (data.providerIds || []).join(", ");
  const overview = codexGatewayCard("OpenCodex",
    data.reachable ? gatewayText("reachable", { origin: data.origin, count: data.gatewayModels?.length || 0 })
      : gatewayText("unreachable", { origin: data.origin }),
    data.reachable ? { label: tKey("quotaSources.online"), kind: "ok" } : { label: tKey("quotaSources.offline"), kind: "warn" });
  overview.appendChild(codexGatewayNote(!providers ? gatewayText("noProviders")
    : data.defaultProvider ? gatewayText("providersDefault", { list: providers, provider: data.defaultProvider })
      : gatewayText("providers", { list: providers })));
  el.codexGatewayList.appendChild(overview);

  if (modelSettingsAgent === "codex") {
    const mode = data.codex?.mode, model = data.codex?.currentModel || "";
    const detail = mode === "gateway" ? (model ? gatewayText("codex.gateway", { model }) : gatewayText("codex.gatewayDefault"))
      : mode === "gateway-other" ? gatewayText("codex.other", { url: data.codex?.baseUrl || "" })
        : mode === "direct" ? gatewayText("codex.direct") : gatewayText("codex.unknown");
    const card = codexGatewayCard("Codex", detail);
    const toNative = mode === "gateway";
    card.appendChild(codexGatewayAction(gatewayText(toNative ? "codex.toNative" : "codex.toGateway"),
      gatewayText(toNative ? "codex.confirmNative" : "codex.confirmGateway"),
      { action: toNative ? "codex_restore_native" : "codex_restore_gateway" }));
    if (mode === "gateway" && !model) card.appendChild(codexGatewayNote(gatewayText("codex.noModel")));
    const listed = (data.catalogModels || []).filter(item => item.visibility === "list").slice(0, 8);
    if (listed.length) {
      const models = document.createElement("div");
      models.className = "opencode-provider-models";
      for (const entry of listed) {
        const chipEl = document.createElement("span");
        chipEl.className = "opencode-provider-model";
        chipEl.textContent = entry.slug;
        models.appendChild(chipEl);
      }
      card.appendChild(models);
    }
    el.codexGatewayList.appendChild(card);
    el.codexGatewayList.appendChild(codexGatewayNote(gatewayText("codex.note")));
  } else {
    const wiring = data.claude?.wiring || null, routing = data.claude?.sessionRouting || null;
    const card = codexGatewayCard("Claude Code", gatewayText(wiring?.enabled ? "claude.enabled" : "claude.disabled"));
    card.appendChild(codexGatewayNote(routing?.enabled
      ? gatewayText("claude.detailGateway", { url: routing.baseUrl || data.origin })
      : gatewayText("claude.detailNative")));
    const enable = !routing?.enabled;
    card.appendChild(codexGatewayAction(gatewayText(enable ? "claude.toGateway" : "claude.toNative"),
      gatewayText(enable ? "claude.confirmGateway" : "claude.confirmNative"),
      { action: "claude_session_routing", enabled: enable }));
    el.codexGatewayList.appendChild(card);
  }
}

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
  el.pushUnsupportedNote?.classList.toggle("hidden", state !== "unsupported");
  renderNotificationsSummary();
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
el.providerAdd?.addEventListener("click", () => currentModelSettingsAgent() === "opencode" ? openOpenCodeProviderDialog() : openProviderDialog());
el.providerCancel?.addEventListener("click", closeProviderDialog);
el.providerCancelBottom?.addEventListener("click", closeProviderDialog);
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
  renderSettings();
  renderAgentHubDisclosure();
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
  renderNotificationsSummary();
  if (!el.onboarding?.classList.contains("hidden")) renderOnboarding();
  if (!el.viewModelSettings.classList.contains("hidden")) renderModelVisibility();
  if (agentTerminal) renderAgentTerminal();
  renderQuotaSources();
  renderApprovalControl();
  if (modelSettingsAgent === "claude-code") void renderClaudeHelperPanel();
  if (isRoutedModelAgent(modelSettingsAgent)) renderCodexGateway();
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
el.setReducedMotion.addEventListener("change", () => { settings = saveSettings({ reducedMotion: el.setReducedMotion.checked }); applyAppearance(); });
el.setThinking.addEventListener("change", () => { settings = saveSettings({ thinking: el.setThinking.value }); });
el.updateAllDevices?.addEventListener("click", () => { void runUpdateAll(); });
el.updateInstallAll?.addEventListener("click", () => { void installAllDeviceUpdates(); });
el.updateDeviceList?.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-update-install]");
  if (button && !button.disabled) void installDeviceUpdate(button.dataset.updateInstall);
});
el.updateDeviceList?.addEventListener("change", (event) => {
  const input = event.target.closest?.("[data-update-auto]");
  if (input && !input.disabled) void saveAutomaticUpdates(input.dataset.updateAuto, input.checked);
});
el.harnessUpdateCheckAll?.addEventListener("click", () => { void runHarnessCheckAll(); });
el.harnessUpdateApplyAll?.addEventListener("click", () => { void applyAllHarnessUpdates(); });
el.harnessUpdateList?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-harness-update-id]");
  if (!button || button.disabled) return;
  void applyHarnessUpdate(button.dataset.harnessUpdateId);
});
// Restores presentation preferences only. The language and the user's own
// project organisation (pins, aliases, removed projects, pinned sessions) are
// data, not interface defaults, so they survive a reset.
// The reset sits on the Appearance page and resets that page's options only.
// Language, projects, model choices and list filters are kept.
const RESET_APPEARANCE_SETTINGS = Object.freeze(["theme", "designTheme", "fontScale", "compact", "thinking", "reducedMotion", "sidebarWidth"]);
el.btnResetSettings?.addEventListener("click", () => {
  if (!confirm(tKey("settings.resetConfirm"))) return;
  settings = saveSettings(Object.fromEntries(RESET_APPEARANCE_SETTINGS.map((key) => [key, DEFAULT_SETTINGS[key]])));
  applyAppearance();
  renderSettings();
  renderSessionList(el.search.value);
  toast(updateText("Interface settings restored"));
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
    // Hostnames are implementation details; the row only needs the state
    // and how this browser reaches the device, on one line.
    const state = m.id === selectedId ? tKey("deviceTrust.inUse", { status: statusLabel }) : statusLabel;
    row.querySelector("small").textContent = state + " · " + machineAuthText(m);
    const actions = row.querySelector(".machine-row-actions");
    const edit = document.createElement("button");
    edit.type = "button"; edit.className = "icon-button-small machine-row-action";
    edit.title = `編輯 ${displayName}`; edit.setAttribute("aria-label", `編輯 ${displayName}`);
    edit.innerHTML = '<svg class="icon"><use href="#i-pencil"></use></svg>';
    edit.addEventListener("click", (event) => { event.stopPropagation(); void openMachineDialog(m); });
    // Removing a device lives in the same dialog as editing it.
    actions.appendChild(edit);
    row.addEventListener("click", () => {
      if (m.id === selectedId) { toast("已在這台設備上"); return; }
      switchMachine(m.id);
      renderMachineList();
      if (!el.viewSettings.classList.contains("hidden")) renderSettings();
    });
    el.machineList.appendChild(row);
  }
  if (updateViewIsOpen()) renderSettingsNavigation();
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
  el.newCwd.value = "";
  updateNewAgentNote();
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
    // An empty initial request lets the Host choose HOME when it is allowed,
    // otherwise its first explicit browse root. Never send a stale device home.
    const path = validatedBrowsePath(requestedPath);
    const query = path ? "?path=" + encodeURIComponent(path) : "";
    const data = await api("/api/browse" + query, { signal: request.signal });
    if (sequence !== projectFolderSequence || machineAtStart !== selectedId || baseAtStart !== apiBase || generation !== viewGeneration) return;
    // `selectable` is additive. Older Hosts identify their filesystem-root
    // bridge by returning the same path as parent; keep that bridge navigable
    // without treating it as an authorized project directory.
    const selectable = typeof data.selectable === "boolean" ? data.selectable : data.path !== data.parent;
    projectFolder = { path: data.path || null, parent: data.parent || null, selectable };
    el.newCwd.value = selectable ? data.path || "" : "";
    el.newFolderPath.textContent = data.path || "—";
    el.newFolderUp.disabled = !data.parent || data.parent === data.path;
    renderProjectFolderList(data.entries || []);
    el.newFolderList.scrollTop = 0;
    updateNewAgentNote();
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
    updateNewAgentNote();
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
    { element: el.agentTerminal, close: requestCloseAgentTerminal },
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
  if (newAgentStartPending) return;
  const connector = agentCatalog.find((item) => item.id === el.newAgent?.value);
  if (agentCatalogError || connector?.installed !== true) { toast(agentHubText("unavailable"), true); return; }
  const cwd = el.newCwd.value.trim();
  if (!cwd) { toast(browseText("Choose a folder first"), true); return; }
  const worktree = !!el.newWorktree?.checked;
  const request = connector.id === "pi" && worktree ? new AbortController() : null;
  newAgentStartPending = true;
  newAgentOpenRequest = request;
  updateNewAgentNote();
  try {
    cancelProjectFolderRequest();
    el.newDialog.classList.add("hidden");
    if (settings.removedProjects?.includes(cwd)) {
      settings = saveSettings({ removedProjects: settings.removedProjects.filter((value) => value !== cwd) });
    }
    await startNew(cwd, el.newName.value.trim() || null, connector.id, worktree, request?.signal || null);
  } finally {
    if (newAgentOpenRequest === request) newAgentOpenRequest = null;
    newAgentStartPending = false;
    updateNewAgentNote();
  }
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
// Background suspension can outlive SSE/poll timers on phones. Reconcile the
// currently selected native conversation when connectivity or visibility
// returns, without replaying prompts or automatically answering approvals.
function refreshVisibleNativeConversation() {
  if (document.hidden || el.viewChat?.classList.contains("hidden")) return;
  const connection = rpc;
  if (!connection?.generic) return;
  const refresh = connection.nativeCodex ? refreshCodexNativeSnapshot
    : connection.nativeOpenCode ? refreshOpenCodeNativeSnapshot
      : connection.nativeClaudeStructured ? refreshClaudeStructuredSnapshot
        : connection.nativeAcp ? refreshAgentClientProtocolSnapshot
          : connection.nativeGrokAcp ? refreshGrokAcpSnapshot
            : connection.nativeAntigravityStructured ? refreshAntigravityStructuredSnapshot : null;
  if (refresh) void refresh(connection).catch(() => {});
}
window.addEventListener("online", refreshVisibleNativeConversation);
document.addEventListener("visibilitychange", refreshVisibleNativeConversation);
window.addEventListener("pageshow", (event) => {
  lockMobilePortrait();
  // A pane belongs to the Workspace, which reloads itself after a return from
  // the back-forward cache; the Settings window and sign-in keep their view.
  void event;
});

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

// A pane is a viewer. Unmounting it must never send stop/close to the Host.
if (WORKSPACE_PANE) {
  window.addEventListener("storage", event => {
    if (event.key !== null && ![SETTINGS_KEY, ...LEGACY_SETTINGS_KEYS].includes(event.key)) return;
    // Update presentation in place: reconnecting here could lose a live draft
    // or attach another provider process when settings change in another window.
    settings = loadSettings(); applyAppearance(); updateComposerSummary();
    renderTaskProgress(); renderProjectChangesChrome(); renderChangesBadge();
  });
  window.addEventListener("pagehide", () => closeChat(true));
  document.addEventListener("pointerdown", () => parent.postMessage({ type: "workspace-focus" }, location.origin), { passive: true });
  window.addEventListener("message", event => {
    if (event.origin === location.origin && event.source === parent && event.data?.type === "workspace-detach") closeChat(true);
  });
}
