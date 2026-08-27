/* pi-web foundation — browser-safe configuration, preferences, and device helpers */
(function exposePiWebFoundation(global) {
  "use strict";

  const SELECTED_KEY = "piweb.selected.v1";
  const SETTINGS_KEY = "piweb.settings.v2";
  const LEGACY_SETTINGS_KEY = "piweb.settings.v1";
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
    try { return global.localStorage.getItem(SELECTED_KEY) || null; } catch { return null; }
  }

  function saveSelected(id) {
    try { global.localStorage.setItem(SELECTED_KEY, id); } catch {}
  }

  function loadSettings() {
    try {
      const v2 = global.localStorage.getItem(SETTINGS_KEY);
      const raw = v2 || global.localStorage.getItem(LEGACY_SETTINGS_KEY) || "{}";
      const parsed = JSON.parse(raw);
      const out = { ...DEFAULT_SETTINGS, ...parsed };
      const savedVersion = Number(parsed.settingsVersion) || 0;
      // Ink & Ivory is the new default. Migrate the old implicit Pine Milk
      // default once, while preserving any other theme the user selected.
      if (savedVersion < SETTINGS_VERSION && (!parsed.designTheme || parsed.designTheme === "pine-milk")) {
        out.designTheme = DEFAULT_SETTINGS.designTheme;
      }
      out.settingsVersion = SETTINGS_VERSION;
      out.locale = global.piI18n?.normalizeLocale(out.locale) || "en";
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
    return name || "Pi Web device";
  }

  function machineDisplayHost(machine) {
    const host = String(machine?.host || "").trim();
    return host ? "Pi Web" : "";
  }

  function machineName(machines, id) {
    const machine = (Array.isArray(machines) ? machines : []).find((item) => item.id === id);
    return machine ? machineDisplayName(machine) : id;
  }

  global.piWebFoundation = Object.freeze({
    SELECTED_KEY,
    SETTINGS_KEY,
    LEGACY_SETTINGS_KEY,
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
  });
})(window);
