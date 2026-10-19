(function (root) {
  "use strict";

  // Each Bot's routines (Hermes cron jobs of its profile): list, edit, run.
  // Hermes keeps and runs them; this view only reads and changes them
  // through /api/assistant/routines on the computer that runs Hermes.

  function create({ api, t, el, button, icon, iconButton, toast, M, locale, actions, botName, botAvatar, openSession }) {
    const WEEKDAYS = [1, 2, 3, 4, 5, 6, 0];
    // 2026-01-04 is a Sunday, so day 0 is Sunday like cron's.
    const dayName = day => new Date(Date.UTC(2026, 0, 4 + day)).toLocaleDateString(locale, { weekday: "long", timeZone: "UTC" });
    const when = iso => { const at = Date.parse(iso || ""); return Number.isFinite(at) ? M.formatWhen(at, Date.now(), locale) : ""; };
    // A schedule people can read; anything the picker cannot express is shown as Hermes wrote it.
    function describe(schedule) {
      const picker = M.pickerFromSchedule(schedule);
      if (picker.kind === "daily") return `${t("daily")} ${picker.time}`;
      if (picker.kind === "weekdays") return `${t("weekdays")} ${picker.time}`;
      if (picker.kind === "weekly") return `${dayName(picker.weekday)} ${picker.time}`;
      if (picker.kind === "interval") return `${t("interval")} ${picker.every} ${t(picker.unit === "h" ? "hours" : "minutes")}`;
      if (picker.kind === "once") return `${t("oneTime")} · ${when(picker.at)}`;
      return schedule.display || picker.raw;
    }
    function statusText(job) {
      if (job.lastDeliveryError) return t("statusDeliveryFailed");
      if (["ok", "success", "completed"].includes(job.lastStatus)) return t("statusOk");
      return job.lastStatus ? t("statusFailed") : "";
    }
    function twoTap(label, confirm, className, action) {
      let armed = false;
      const node = button(label, className, async () => {
        if (!armed) {
          armed = true;
          node.textContent = confirm;
          setTimeout(() => { armed = false; node.textContent = label; }, 4000);
          return;
        }
        node.disabled = true;
        try { await action(); } catch (error) { toast(t("failed", { message: error.message })); node.disabled = false; }
      });
      return node;
    }

    async function list(container, profile) {
      container.replaceChildren(el("p", "assistant-empty", t("loading")));
      try { render(container, (await api.routines(profile)).routines || [], profile); } catch (error) {
        container.replaceChildren(el("p", "assistant-error", t("failed", { message: error.message })));
      }
    }

    // Quiet rows, as in the list beside: a routine's name and when it runs.
    // Run now stays on the row; the rest is in its ⋯ menu.
    function render(container, jobs, profile) {
      const wrap = el("div", "assistant-routines");
      if (profile) {
        const add = button("", "assistant-routine-add", () => editor(container, profile, null, profile)), tile = el("span", "assistant-add-tile");
        tile.append(icon("plus")); add.append(tile, el("strong", "", t("newRoutine"))); wrap.append(add);
      }
      if (!jobs.length) wrap.append(el("p", "assistant-empty", t("noRoutines")));
      let group = null;
      for (const job of profile ? jobs : [...jobs].sort((a, b) => a.profile.localeCompare(b.profile))) {
        if (!profile && job.profile !== group) {
          group = job.profile;
          const heading = el("h2", "assistant-routine-group"); heading.append(botAvatar(group), el("span", "", botName(group))); wrap.append(heading);
        }
        wrap.append(row(container, job, profile));
      }
      container.replaceChildren(wrap);
    }

    function row(container, job, profile) {
      const item = el("section", `assistant-routine${job.enabled ? "" : " paused"}`);
      item.dataset.routine = job.id;
      const name = M.routineName(job.name) || job.prompt.slice(0, 60) || t("untitled");
      const open = button("", "assistant-routine-open", () => editor(container, job.profile, job, profile)), head = el("span", "assistant-routine-head");
      head.append(el("strong", "", name));
      if (!job.enabled) head.append(el("span", "assistant-routine-tag", t("paused")));
      const facts = [describe(job.schedule), job.enabled && job.nextRunAt ? t("nextRun", { time: when(job.nextRunAt) }) : "", statusText(job),
        job.noAgent ? t("scriptOnly") : ""].filter(Boolean).join(" · ");
      open.append(head, el("small", "assistant-routine-facts", facts));
      const refresh = updated => { Object.assign(job, updated.routine); item.replaceWith(row(container, job, profile)); };
      const run = twoTap(t("runNow"), t("confirmRun"), "btn assistant-routine-run", async () => refresh(await api.runRoutine(job.id, job.profile)));
      const fail = error => toast(t("failed", { message: error.message }));
      const more = iconButton("more", `${t("moreOptions")} · ${name}`, "assistant-routine-more", () => actions(more, name, facts, [
        { label: job.enabled ? t("pause") : t("resume"), icon: job.enabled ? "pause" : "play", action: async () => {
          try { refresh(await (job.enabled ? api.pauseRoutine(job.id, job.profile) : api.resumeRoutine(job.id, job.profile))); } catch (error) { fail(error); }
        } },
        { label: t("history"), icon: "clock", action: () => showRuns(item, job) },
        { label: t("editRoutine"), icon: "edit", action: () => editor(container, job.profile, job, profile) },
        { label: t("delete"), confirm: t("confirmDelete"), icon: "trash", danger: true, action: async () => {
          try { await api.deleteRoutine(job.id, job.profile); item.remove(); } catch (error) { fail(error); }
        } },
      ]));
      more.setAttribute("aria-haspopup", "dialog");
      item.append(open, run, more);
      return item;
    }

    async function showRuns(item, job) {
      const open = item.querySelector(".assistant-runs");
      if (open) { open.remove(); return; }
      const box = el("ul", "assistant-runs");
      box.append(el("li", "assistant-empty", t("loading")));
      item.append(box);
      try {
        const runs = (await api.routineRuns(job.id, job.profile)).runs || [];
        box.replaceChildren();
        if (!runs.length) box.append(el("li", "assistant-empty", t("noRuns")));
        for (const run of runs) {
          const entry = el("li");
          const label = [run.title || t("untitled"), M.formatWhen(run.startedAt, Date.now(), locale)].filter(Boolean).join(" · ");
          entry.append(run.openable ? button(label, "assistant-run-open", () => openSession(job.profile, run.id, run.title)) : el("span", "", label));
          if (run.preview) entry.append(el("small", "", run.preview));
          box.append(entry);
        }
      } catch (error) { box.replaceChildren(el("li", "assistant-error", t("failed", { message: error.message }))); }
    }

    function labeled(label, ...nodes) {
      const wrap = el("label", "assistant-field");
      wrap.append(el("span", "", label), ...nodes);
      return wrap;
    }
    function select(options, value) {
      const node = el("select");
      for (const [key, label] of options) { const option = el("option", "", label); option.value = key; node.append(option); }
      node.value = value;
      return node;
    }

    function editor(container, profile, job, listProfile) {
      const picker = job ? M.pickerFromSchedule(job.schedule) : { kind: "daily", time: "09:00" };
      const form = el("form", "assistant-routine-form");
      const name = el("input");
      name.value = job ? M.routineName(job.name) : "";
      const kind = select([["daily", t("daily")], ["weekdays", t("weekdays")], ["weekly", t("weekly")], ["interval", t("interval")],
        ["once", t("oneTime")], ["advanced", t("advanced")]], picker.kind);
      const time = el("input"); time.type = "time"; time.value = picker.time || "09:00";
      const weekday = select(WEEKDAYS.map(day => [String(day), dayName(day)]), String(picker.weekday ?? 1));
      const every = el("input"); every.type = "number"; every.min = "1"; every.value = String(picker.every || 30);
      const unit = select([["m", t("minutes")], ["h", t("hours")]], picker.unit || "m");
      const at = el("input"); at.type = "datetime-local"; at.value = picker.at || "";
      const raw = el("input"); raw.value = picker.raw || ""; raw.placeholder = "0 9 * * 1-5";
      const parts = { time: labeled(t("atTime"), time), weekday: labeled(t("onDay"), weekday), every: labeled(t("interval"), every, unit),
        at: labeled(t("atTime"), at), raw: labeled(t("rawSchedule"), raw) };
      const showParts = () => {
        parts.time.hidden = !["daily", "weekdays", "weekly"].includes(kind.value);
        parts.weekday.hidden = kind.value !== "weekly";
        parts.every.hidden = kind.value !== "interval";
        parts.at.hidden = kind.value !== "once";
        parts.raw.hidden = kind.value !== "advanced";
      };
      kind.addEventListener("change", showParts);
      showParts();
      const schedule = el("fieldset", "assistant-routine-schedule");
      schedule.append(el("legend", "", t("when")), kind, ...Object.values(parts));
      const prompt = el("textarea");
      prompt.rows = 4;
      prompt.value = job?.prompt || "";
      const deliver = el("fieldset", "assistant-routine-deliver");
      deliver.append(el("legend", "", t("deliverTo")));
      const chosen = M.deliverTokens(job ? job.deliver : "bot-chat");
      const checks = [];
      const addTarget = (token, label) => {
        if (checks.some(box => box.value === token)) return;
        const wrap = el("label", "assistant-check");
        const box = el("input");
        box.type = "checkbox"; box.value = token; box.checked = chosen.includes(token);
        wrap.append(box, el("span", "", label));
        deliver.append(wrap);
        checks.push(box);
      };
      addTarget("bot-chat", t("botChatTarget"));
      const addChosen = () => { for (const token of chosen) addTarget(token, token); };
      void api.routineTargets(profile).then(data => { for (const target of data.targets || []) addTarget(target.id, target.name); addChosen(); }).catch(addChosen);
      const model = el("input"); model.value = job?.model || "";
      const skills = el("input"); skills.value = (job?.skills || []).join(", ");
      const error = el("p", "assistant-error"); error.hidden = true;
      const save = button(t("save"), "btn primary", null, "submit");
      const actions = el("div", "assistant-ask-actions");
      actions.append(save, button(t("cancel"), "btn ghost", () => void list(container, listProfile)));
      form.append(el("h2", "", job ? t("editRoutine") : t("newRoutine")), labeled(t("routineName"), name), schedule, labeled(t("instructions"), prompt),
        deliver, labeled(t("modelOptional"), model), labeled(t("skillsOptional"), skills), error, actions);
      form.addEventListener("submit", async event => {
        event.preventDefault();
        const tokens = checks.filter(box => box.checked).map(box => box.value);
        const fields = { name: name.value.trim(), prompt: prompt.value, deliver: tokens.length ? tokens.join(",") : "local", model: model.value.trim(),
          skills: skills.value.split(",").map(item => item.trim()).filter(Boolean),
          schedule: M.scheduleFromPicker({ kind: kind.value, time: time.value, weekday: weekday.value, every: every.value, unit: unit.value, at: at.value, raw: raw.value }) };
        save.disabled = true;
        error.hidden = true;
        try {
          if (job) await api.updateRoutine(job.id, profile, fields); else await api.createRoutine(profile, fields);
          await list(container, listProfile);
        } catch (failure) {
          error.textContent = t("failed", { message: failure.message });
          error.hidden = false;
          save.disabled = false;
        }
      });
      container.replaceChildren(form);
      name.focus();
    }

    return Object.freeze({ list });
  }

  root.StepsembleAssistantRoutines = Object.freeze({ create });
})(window);
