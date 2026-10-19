/* The sidebar's Automations: every computer's Schedules and the Bots'
   routines in one list, the ones that need attention first, then by their
   next run. Pure: the Workspace gathers the data and draws the rows. */
(function (root, factory) { const api = factory(); if (typeof module === "object" && module.exports) module.exports = api; else root.StepsembleWorkspaceAutomations = api; })(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";
  const RANK = { attention: 0, scheduled: 1, paused: 2, finished: 3 };
  const OK = new Set(["ok", "success", "completed"]);
  const time = value => { const at = typeof value === "number" ? value : Date.parse(value || ""); return Number.isFinite(at) ? at : null; };
  // schedules: [{ target, owner, items }] from each computer's /api/workflows;
  // routines: { target, items, bots } from the computer that runs Hermes.
  function collect({ schedules = [], routines = null, scheduleLabel = () => "", routineLabel = () => "" } = {}) {
    const rows = [];
    for (const group of schedules) for (const item of group.items || []) {
      if (!item?.id) continue;
      const finished = !item.enabled && item.schedule?.kind === "once" && !item.nextAt && !!item.lastRunId;
      const state = item.enabled ? (item.capacityBlocked ? "attention" : "scheduled") : finished ? "finished" : "paused";
      rows.push({ kind: "schedule", key: `schedule:${group.target}:${item.id}`, target: group.target, id: item.id, title: String(item.title || ""),
        cadence: item.schedule ? scheduleLabel(item.schedule) : "", nextAt: item.enabled ? time(item.nextAt) : null, state, owner: group.owner ?? group.target, agentId: item.agentId || "" });
    }
    const bots = new Map((routines?.bots || []).map(bot => [bot.name, bot]));
    for (const item of routines?.items || []) {
      if (!item?.id) continue;
      const failed = !!item.lastDeliveryError || !!item.lastStatus && !OK.has(item.lastStatus);
      const state = item.enabled === false ? "paused" : failed ? "attention" : "scheduled";
      const bot = bots.get(item.profile) || { name: item.profile };
      rows.push({ kind: "routine", key: `routine:${item.profile}:${item.id}`, target: routines.target, id: String(item.id), profile: item.profile || "",
        title: String(item.name || ""), cadence: item.schedule ? routineLabel(item.schedule) : "", nextAt: item.enabled === false ? null : time(item.nextRunAt),
        state, owner: bot.displayName || bot.name || item.profile || "", bot });
    }
    return sorted(rows);
  }
  function sorted(rows) {
    return [...rows].sort((a, b) => RANK[a.state] - RANK[b.state]
      || (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity)
      || a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
  }
  // "Today 09:00", "Tomorrow 03:15", a weekday this week, a date after.
  function nextLabel(at, now = Date.now(), locale = "en") {
    if (!Number.isFinite(at)) return "";
    const date = new Date(at), clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
    const day = value => { const d = new Date(value); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const days = Math.round((day(at) - day(now)) / 86_400_000);
    if (days >= 0 && days <= 1) return `${new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(days, "day")} ${clock}`;
    if (days > 1 && days < 7) return `${new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date)} ${clock}`;
    return `${new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date)} ${clock}`;
  }
  // A Bot's routine schedule as its own Routines page words it.
  function routineCadence(schedule, { M, t, locale = "en" }) {
    const picker = M.pickerFromSchedule(schedule);
    if (picker.kind === "daily") return `${t("daily")} ${picker.time}`;
    if (picker.kind === "weekdays") return `${t("weekdays")} ${picker.time}`;
    if (picker.kind === "weekly") return `${new Date(Date.UTC(2026, 0, 4 + picker.weekday)).toLocaleDateString(locale, { weekday: "long", timeZone: "UTC" })} ${picker.time}`;
    if (picker.kind === "interval") return `${t("interval")} ${picker.every} ${t(picker.unit === "h" ? "hours" : "minutes")}`;
    if (picker.kind === "once") return t("oneTime");
    return typeof schedule === "string" ? schedule : schedule?.display || schedule?.expr || "";
  }
  return { collect, sorted, nextLabel, routineCadence };
});
