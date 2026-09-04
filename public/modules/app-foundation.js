/* stepsemble foundation — browser-safe configuration, preferences, and device helpers */
(function exposeStepsembleFoundation(global) {
  "use strict";

  const SELECTED_KEY = "stepsemble.selected.v1";
  const SETTINGS_KEY = "stepsemble.settings.v2";
  // Read both former product generations, then write the value under the
  // Stepsemble key. Legacy entries remain untouched for safe v2 rollback.
  const LEGACY_SELECTED_KEYS = Object.freeze(["piharbor.selected.v1", "piweb.selected.v1"]);
  const LEGACY_SELECTED_KEY = LEGACY_SELECTED_KEYS[0];
  const LEGACY_SETTINGS_KEYS = Object.freeze([
    "piharbor.settings.v2",
    "piharbor.settings.v1",
    "piweb.settings.v2",
    "piweb.settings.v1",
    "stepsemble.settings.v1",
  ]);
  const LEGACY_SETTINGS_KEY = LEGACY_SETTINGS_KEYS[0];
  const SETTINGS_VERSION = 3;
  const DESIGN_THEMES = Object.freeze([
    { id: "pine-milk", label: "Pine Milk" },
    { id: "warm-paper", label: "Warm Paper" },
    { id: "graphite", label: "Graphite" },
    { id: "ink-ivory", label: "Ink & Ivory" },
    { id: "plum-milk", label: "Plum & Milk" },
    { id: "ocean-ivory", label: "Ocean & Ivory" },
    { id: "cloud-jet", label: "Cloud & Jet" },
    { id: "cloud-smog", label: "Cloud & Smog" },
    { id: "etoile", label: "Our Étoile" },
  ]);
  const DESIGN_THEME_IDS = new Set(DESIGN_THEMES.map((theme) => theme.id));
  const DEFAULT_SETTINGS = Object.freeze({
    locale: "en",
    theme: "auto",          // auto | light | dark
    designTheme: "ink-ivory",
    settingsVersion: SETTINGS_VERSION,
    sidebarWidth: 336,
    fontScale: 100,
    compact: false,
    groupByProject: true,
    reducedMotion: false,
    thinking: "collapsed",  // collapsed | open
    modelVisibility: {},     // machineId -> hidden model keys[]
    projectPins: [],         // cwd strings pinned to the top of the project list
    projectAliases: {},      // cwd -> user-facing project label
    removedProjects: [],     // cwd strings hidden from the project list
    sessionPins: [],         // session file paths pinned within a project
    showTemporarySessions: false, // opt-in to Sub Agent sessions created under a temp root
  });

  function loadSelected() {
    try {
      const current = global.localStorage.getItem(SELECTED_KEY);
      if (current) return current;
      const legacy = LEGACY_SELECTED_KEYS.map((key) => global.localStorage.getItem(key)).find(Boolean) || null;
      if (legacy) global.localStorage.setItem(SELECTED_KEY, legacy);
      return legacy;
    } catch { return null; }
  }

  function saveSelected(id) {
    try { global.localStorage.setItem(SELECTED_KEY, id); } catch {}
  }

  function loadSettings() {
    try {
      const v2 = global.localStorage.getItem(SETTINGS_KEY);
      const raw = v2 || LEGACY_SETTINGS_KEYS.map((key) => global.localStorage.getItem(key)).find(Boolean) || "{}";
      const parsed = JSON.parse(raw);
      const out = { ...DEFAULT_SETTINGS, ...parsed };
      // Ink & Ivory is the default for anyone who never picked a theme. A saved
      // choice is always kept, including Pine Milk, which now has its own
      // palette instead of silently falling back to the default colours.
      if (!parsed.designTheme) out.designTheme = DEFAULT_SETTINGS.designTheme;
      out.settingsVersion = SETTINGS_VERSION;
      out.locale = global.stepsembleI18n?.normalizeLocale(out.locale) || "en";
      if (!DESIGN_THEME_IDS.has(out.designTheme)) out.designTheme = DEFAULT_SETTINGS.designTheme;
      out.sidebarWidth = Math.min(440, Math.max(280, Number(out.sidebarWidth) || DEFAULT_SETTINGS.sidebarWidth));
      out.fontScale = Math.min(125, Math.max(90, Number(out.fontScale) || DEFAULT_SETTINGS.fontScale));
      out.projectPins = Array.isArray(out.projectPins)
        ? [...new Set(out.projectPins.filter((value) => typeof value === "string" && value.trim()))].slice(0, 200)
        : [];
      out.projectAliases = out.projectAliases && typeof out.projectAliases === "object" && !Array.isArray(out.projectAliases)
        ? Object.fromEntries(Object.entries(out.projectAliases)
          .filter(([key, value]) => typeof key === "string" && typeof value === "string" && value.trim())
          .slice(0, 200))
        : {};
      out.removedProjects = Array.isArray(out.removedProjects)
        ? [...new Set(out.removedProjects.filter((value) => typeof value === "string" && value.trim()))].slice(0, 200)
        : [];
      out.sessionPins = Array.isArray(out.sessionPins)
        ? [...new Set(out.sessionPins.filter((value) => typeof value === "string" && value.trim()))].slice(0, 500)
        : [];
      out.showTemporarySessions = parsed.showTemporarySessions === true;
      // v1 的舊設定可能明確關閉分組；v2 首次啟用時以 Project folders 為預設。
      if (!v2) out.groupByProject = true;
      if (!v2 && raw !== "{}") global.localStorage.setItem(SETTINGS_KEY, JSON.stringify(out));
      return out;
    } catch { return { ...DEFAULT_SETTINGS }; }
  }

  function saveSettings(patch) {
    const next = { ...loadSettings(), ...patch };
    try { global.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch {}
    return next;
  }

  function currentMachine(machines, selectedId) {
    const list = Array.isArray(machines) ? machines : [];
    return list.find((machine) => machine.id === selectedId)
      || list.find((machine) => machine.self)
      || list[0]
      || null;
  }

  function machineDisplayName(machine) {
    if (!machine) return "";
    const name = String(typeof machine === "string" ? machine : machine?.name || "").trim();
    // Keep the configured alias. Do not bake a user's computer model into the
    // public client; a generic fallback is safer for newly discovered hosts.
    return name || "Stepsemble device";
  }

  function machineDisplayHost(machine) {
    const host = String(machine?.host || "").trim();
    return host ? "Stepsemble" : "";
  }

  function machineName(machines, id) {
    const machine = (Array.isArray(machines) ? machines : []).find((item) => item.id === id);
    return machine ? machineDisplayName(machine) : id;
  }

  /**
   * Resolve the authoritative machine catalog into the three values the
   * controller needs.  Keeping this pure makes the selection rules testable
   * without a DOM or a network request and, importantly, does not depend on
   * apiBase (which may still point at a previously selected remote device).
   */
  function resolveMachineCatalogState(data, { selectedId = null, savedSelectedId = null } = {}) {
    const machines = Array.isArray(data?.machines)
      ? data.machines.filter((machine) => machine && typeof machine.id === "string" && machine.id)
      : [];
    const ids = new Set(machines.map((machine) => machine.id));
    const hintedSelfId = typeof data?.current === "string" && ids.has(data.current) ? data.current : null;
    const selfId = hintedSelfId || machines.find((machine) => machine.self)?.id || null;
    const retainedId = [selectedId, savedSelectedId].find((id) => typeof id === "string" && ids.has(id)) || null;
    return {
      machines,
      selfId,
      selectedId: retainedId || selfId || machines[0]?.id || null,
    };
  }

  async function retryWithBackoff(operation, { delays = [], shouldRetry = () => true, onRetry = () => {} } = {}) {
    const retryDelays = Array.isArray(delays) ? delays : [];
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      try { return await operation(); }
      catch (error) {
        if (attempt >= retryDelays.length || !shouldRetry(error, attempt)) throw error;
        const delay = Math.max(0, Number(retryDelays[attempt]) || 0);
        onRetry(error, attempt + 1);
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    throw new Error("Retry operation exhausted");
  }

  global.stepsembleFoundation = Object.freeze({
    SELECTED_KEY,
    SETTINGS_KEY,
    LEGACY_SETTINGS_KEY,
    LEGACY_SETTINGS_KEYS,
    LEGACY_SELECTED_KEYS,
    SETTINGS_VERSION,
    DESIGN_THEMES,
    DESIGN_THEME_IDS,
    DEFAULT_SETTINGS,
    loadSelected,
    saveSelected,
    loadSettings,
    saveSettings,
    currentMachine,
    machineDisplayName,
    machineDisplayHost,
    machineName,
    resolveMachineCatalogState,
    retryWithBackoff,
  });
  // A cached v2 controller can briefly execute beside a freshly updated
  // foundation module. Keep the old global as a read-only alias for that one
  // rolling-update window.
  global.piHarborFoundation = global.stepsembleFoundation;
})(window);
