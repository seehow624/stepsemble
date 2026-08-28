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

  global.piHarborSessionUtils = Object.freeze({
    stripMd, fmtTime, fmtTokens, projectFolderName,
    activityReceiptStats, computeActivityReceipt,
  });
})(window);
