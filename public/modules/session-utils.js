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

  global.piHarborSessionUtils = Object.freeze({ stripMd, fmtTime, fmtTokens, projectFolderName });
})(window);
