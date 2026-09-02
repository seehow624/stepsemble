/* pi-harbor session utilities — pure display helpers shared by list and chat views */
(function exposePiHarborSessionUtils(global) {
  "use strict";

  function stripMd(value) {
    return (value || "")
      .replace(/[#*_`~>\[\]]/g, "")
      .replace(/\((https?:\/\/)[^)]*\)/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  function fmtTime(timestamp) {
    if (!timestamp) return "";
    const date = new Date(timestamp);
    const now = new Date();
    const selectedLocale = global.piI18n?.getLocale?.() || "en";
    const dateLocale = selectedLocale === "zh-Hant" ? "zh-TW"
      : selectedLocale === "zh-Hans" ? "zh-CN" : selectedLocale;
    const hm = date.toLocaleTimeString(dateLocale, { hour: "2-digit", minute: "2-digit" });
    if (date.toDateString() === now.toDateString()) return hm;
    const days = Math.floor((now - date) / 86400000);
    if (days < 7) {
      const relative = new Intl.RelativeTimeFormat(dateLocale, { numeric: "always" }).format(-days, "day");
      return `${relative} ${hm}`;
    }
    return date.toLocaleDateString(dateLocale, { month: "numeric", day: "numeric" }) + " " + hm;
  }

  function fmtTokens(value) {
    if (!value) return "";
    return value >= 1000 ? (value / 1000).toFixed(value >= 10000 ? 0 : 1) + "k" : String(value);
  }

  function projectFolderName(cwd) {
    const key = String(cwd || "(unknown)");
    const unassigned = global.piI18n?.t("Unassigned project") || "Unassigned project";
    return key === "(unknown)" ? unassigned : (key.split("/").filter(Boolean).pop() || key);
  }

  // Composer drafts are deliberately plain data so the controller can keep
  // each device/session isolated while tests exercise retention and pruning
  // without needing a DOM or a browser storage implementation.
  const DRAFT_ENTRY_LIMIT = 50;
  const DRAFT_TEXT_LIMIT = 40000;

  function draftScopeKey(machineId, { file = "", cwd = "", name = "" } = {}) {
    const machine = String(machineId || "local").trim() || "local";
    const sessionFile = String(file || "").trim();
    return JSON.stringify(sessionFile
      ? [machine, "session", sessionFile]
      : [machine, "new", String(cwd || "").trim(), String(name || "").trim()]);
  }

  function normalizeDraftEntries(value) {
    let rows = value;
    if (typeof rows === "string") {
      try { rows = JSON.parse(rows); } catch { rows = []; }
    }
    if (!Array.isArray(rows) && Array.isArray(rows?.entries)) rows = rows.entries;
    if (!Array.isArray(rows)) rows = [];

    const newestByKey = new Map();
    for (const row of rows) {
      const key = typeof row?.key === "string" ? row.key : "";
      const text = typeof row?.text === "string" ? row.text.slice(0, DRAFT_TEXT_LIMIT) : "";
      const updatedAt = Number(row?.updatedAt);
      if (!key || !text.trim() || !Number.isFinite(updatedAt)) continue;
      const previous = newestByKey.get(key);
      if (!previous || updatedAt > previous.updatedAt) newestByKey.set(key, { key, text, updatedAt });
    }
    return [...newestByKey.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, DRAFT_ENTRY_LIMIT);
  }

  function updateDraftEntries(value, key, text, updatedAt = Date.now()) {
    const draftKey = String(key || "");
    const rows = normalizeDraftEntries(value).filter((row) => row.key !== draftKey);
    const draftText = String(text ?? "").slice(0, DRAFT_TEXT_LIMIT);
    if (draftKey && draftText.trim()) rows.unshift({ key: draftKey, text: draftText, updatedAt: Number(updatedAt) || Date.now() });
    return normalizeDraftEntries(rows);
  }

  function draftTextForKey(value, key) {
    return normalizeDraftEntries(value).find((row) => row.key === key)?.text || "";
  }

  // Tool metadata is deliberately kept as a plain-data helper.  The browser
  // controller can pass its DOM cards here while node:test can exercise the
  // receipt rules without a DOM implementation.
  function positiveCount(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  function editToolName(name) {
    return /(?:write|edit|patch)/.test(String(name || "").toLowerCase().replace(/[^a-z0-9_-]/g, ""));
  }

  function fileTargetFromArgs(args) {
    if (typeof args === "string") {
      const value = args.trim().replace(/^['"]|['"]$/g, "");
      return value && !/\s/.test(value) ? value : "";
    }
    if (!args || typeof args !== "object") return "";
    for (const key of ["path", "file_path", "filePath", "filename", "file"]) {
      if (typeof args[key] === "string" && args[key].trim()) {
        return args[key].trim().replace(/^['"]|['"]$/g, "");
      }
    }
    return "";
  }

  function activityReceiptStats(cards) {
    const rows = Array.isArray(cards) ? cards : [];
    const editedFiles = new Set();
    let hadToolError = false;
    for (const row of rows) {
      const meta = row?.__tool && typeof row.__tool === "object" ? row.__tool : row;
      if (row?.isError || row?.error || row?.classList?.contains?.("err") || row?.className?.includes?.("err")) {
        hadToolError = true;
      }
      if (!editToolName(meta?.name)) continue;
      const target = fileTargetFromArgs(meta?.args);
      if (target) editedFiles.add(target);
    }
    return {
      toolCount: rows.length,
      editedFileCount: editedFiles.size,
      hadToolError,
    };
  }

  // Pi extensions send widget text with terminal colour escape sequences when
  // they reuse the TUI theme helpers. The web client must treat that text as
  // data, not markup, and should never expose the escape bytes in a browser.
  const ANSI_ESCAPE_RE = /(?:\u001B\][^\u0007]*(?:\u0007|\u001B\\)|\u001B\[[0-?]*[ -/]*[@-~]|\u009B[0-?]*[ -/]*[@-~])/g;

  function stripAnsi(value) {
    return String(value ?? "").replace(ANSI_ESCAPE_RE, "").replace(/\u0000/g, "");
  }

  function cleanTaskProgressText(value) {
    return stripAnsi(value)
      .replace(/^\s*~~([\s\S]*?)~~\s*$/, "$1")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 500);
  }

  function taskMarkerState(value) {
    const match = String(value || "").match(/^(?:\[(x|X|✓|✔|✅| )\]|(☑|☒|☐|□|▣|✓|✔|✅|○|◯|●|◉))\s*/u);
    if (!match) return null;
    const marker = match[1] || match[2] || "";
    return {
      completed: ![" ", "☐", "□", "○", "◯"].includes(marker),
      text: String(value).slice(match[0].length),
    };
  }

  /**
   * Parse the small, plain-text task widgets emitted by Pi extensions. It
   * accepts both the plan-mode format (`☑ step`) and ordinary numbered or
   * Markdown checklist rows so custom extensions can use the same web UI.
   */
  function parseTaskProgressLines(lines, { allowPlain = false, maxItems = 50 } = {}) {
    const items = [];
    const notes = [];
    const source = Array.isArray(lines) ? lines : [];
    for (const raw of source.slice(0, 100)) {
      let value = stripAnsi(raw).replace(/[\r\n]+/g, " ").trim();
      if (!value || /^(?:[-=_]){3,}$/.test(value)) continue;

      // A leading bullet is only presentation; the checkbox/number below
      // carries the semantic state. Keep track of plain bullets for custom
      // task widgets that do not use a checkbox marker.
      const hadBullet = /^[-*•]\s+/.test(value);
      if (hadBullet) value = value.replace(/^[-*•]\s+/, "");

      let step = null;
      let marker = null;
      let changed = true;
      while (changed) {
        changed = false;
        if (marker === null) {
          const nextMarker = taskMarkerState(value);
          if (nextMarker) {
            marker = nextMarker;
            value = nextMarker.text.trim();
            changed = true;
          }
        }
        if (step === null) {
          const nextNumber = value.match(/^(\d{1,3})[.)]\s+/);
          if (nextNumber) {
            const parsedStep = Number(nextNumber[1]);
            if (Number.isSafeInteger(parsedStep) && parsedStep > 0) step = parsedStep;
            value = value.slice(nextNumber[0].length).trim();
            changed = true;
          }
        }
      }

      const structured = step !== null || marker !== null || (allowPlain && hadBullet);
      const text = cleanTaskProgressText(value);
      if (!structured || !text) {
        if (text && notes.length < 10) notes.push(text);
        continue;
      }
      if (items.length >= Math.max(1, Number(maxItems) || 50)) continue;
      items.push({
        step: step || items.length + 1,
        text,
        completed: marker ? marker.completed : false,
      });
    }
    return { items, notes };
  }

  function extractTaskPlan(text) {
    const source = stripAnsi(text);
    const header = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:[*_]{0,3}\s*)?Plan(?:\s+Steps?)?(?:\s*\(\d{1,3}\))?\s*(?:[*_]{0,3}\s*)?:?\s*(?:[*_]{0,3}\s*)?(?:\n|$)/i.exec(source);
    if (!header) return [];
    const start = header.index + header[0].length;
    const section = [];
    for (const line of source.slice(start).split(/\r?\n/)) {
      if (section.length && /^\s*#{1,6}\s+/.test(line)) break;
      if (section.length && /^\s*(?:Progress|Implementation|Notes?|Summary|Next steps?)\s*:\s*$/i.test(line)) break;
      section.push(line);
      if (section.length >= 100) break;
    }
    return parseTaskProgressLines(section).items;
  }

  /**
   * Decide whether a run deserves a receipt and which reliable outcome it has.
   * `outcome` is supplied only by lifecycle events (settled, failure, exit);
   * a plain successful settle without a final assistant message is therefore
   * intentionally labelled interrupted rather than guessed as complete.
   */
  function computeActivityReceipt({
    toolCount = 0,
    editedFileCount = 0,
    finalResponse = false,
    outcome = "completed",
  } = {}) {
    const tools = positiveCount(toolCount);
    if (!tools) return null;
    const files = positiveCount(editedFileCount);
    const validOutcome = new Set(["completed", "failed", "interrupted"]);
    let status = validOutcome.has(outcome) ? outcome : "completed";
    if (status === "completed" && !finalResponse) status = "interrupted";
    return Object.freeze({
      status,
      editedFileCount: files,
      toolCount: tools,
      noFinalResponse: status === "interrupted" && !finalResponse,
    });
  }

  // Elapsed time for a running turn. Seconds under a minute, m:ss below an
  // hour, then h:mm:ss, so a glance answers "how long has this been going?"
  function runElapsedText(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    if (total < 60) return `${total}s`;
    const seconds = total % 60;
    const minutes = Math.floor(total / 60) % 60;
    const hours = Math.floor(total / 3600);
    const pad = (value) => String(value).padStart(2, "0");
    return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
  }

  global.piHarborSessionUtils = Object.freeze({
    stripMd, fmtTime, fmtTokens, projectFolderName,
    DRAFT_ENTRY_LIMIT, DRAFT_TEXT_LIMIT, draftScopeKey, normalizeDraftEntries, updateDraftEntries, draftTextForKey,
    activityReceiptStats, computeActivityReceipt,
    stripAnsi, parseTaskProgressLines, extractTaskPlan,
    runElapsedText,
  });
})(window);
