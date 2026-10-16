(function (root) {
  "use strict";

  // 歷史面板只管理搜尋、分頁與列操作，導航交給外層控制器。
  // 不同 profile 分開保存查詢與捲動，關閉後拒收過期的 API 結果。
  function create({ api, t, el, button, M, locale, showPanel, onSelect }) {
    const saved = new Map();
    let active = null, serial = 0, timer = 0;
    function close() {
      clearTimeout(timer); serial += 1;
      if (active) active.state.scrollTop = active.scroll.scrollTop;
      active = null;
    }
    function open(profile, botName) {
      close();
      if (!saved.has(profile)) saved.set(profile, { query: "", rows: [], hasMore: false, scrollTop: 0, loaded: false, offset: 0 });
      const state = saved.get(profile);
      const panel = showPanel(t("historyTitle"), botName);
      const search = el("input", "assistant-search");
      search.type = "search"; search.value = state.query; search.placeholder = t("search"); search.setAttribute("aria-label", t("search"));
      const scroll = el("div", "assistant-history-scroll"), list = el("ul", "assistant-session-list");
      const status = el("div", "assistant-history-status");
      const more = button(t("loadMore"), "btn ghost", () => void load(false));
      more.hidden = !state.hasMore;
      scroll.append(list, status, more);
      panel.body.append(search, scroll);
      const entry = { profile, state, panel, scroll, list, status, more, pending: false, error: null };
      active = entry;
      scroll.addEventListener("scroll", () => { if (active === entry) state.scrollTop = scroll.scrollTop; }, { passive: true });
      search.addEventListener("input", () => {
        clearTimeout(timer); serial += 1;
        state.query = search.value.trim(); state.rows = []; state.hasMore = false; state.scrollTop = 0; state.loaded = false; state.offset = 0;
        entry.pending = true; entry.error = null; render(entry);
        timer = setTimeout(() => { if (active === entry) void load(true); }, 250);
      });
      render(entry);
      requestAnimationFrame(() => { if (active === entry) { scroll.scrollTop = state.scrollTop; search.focus(); } });
      if (!state.loaded) void load(true);
      async function load(reset) {
        if (active !== entry) return;
        const ticket = ++serial;
        entry.pending = true; entry.error = null; render(entry);
        try {
          const offset = reset ? 0 : state.offset;
          const data = await api.sessions(profile, state.query, offset);
          if (active !== entry || ticket !== serial) return;
          const rows = reset ? data.sessions : [...state.rows, ...data.sessions];
          state.rows = [...new Map(rows.map(row => [row.id, row])).values()];
          state.offset = Number.isSafeInteger(data.nextOffset) ? data.nextOffset : offset + data.sessions.length;
          state.hasMore = data.hasMore === true; state.loaded = true;
        } catch (error) { if (active === entry && ticket === serial) entry.error = error; }
        finally { if (active === entry && ticket === serial) { entry.pending = false; render(entry); } }
      }
      entry.reload = () => load(true);
      return panel;
    }
    function dayLabel(seconds) {
      const value = Number(seconds) || 0;
      if (!value) return t("older");
      const date = new Date(value < 1e12 ? value * 1000 : value), today = new Date(), yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      if (date.toDateString() === today.toDateString()) return t("today");
      if (date.toDateString() === yesterday.toDateString()) return t("yesterday");
      return date.toLocaleDateString(locale, { year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined, month: "long", day: "numeric" });
    }
    function render(entry) {
      const { state, list, status, more } = entry;
      list.replaceChildren();
      let day = null;
      for (const row of state.rows) {
        const label = dayLabel(row.lastActive || row.startedAt);
        if (label !== day) { day = label; list.append(el("li", "assistant-history-date", label)); }
        list.append(rowNode(entry, row));
      }
      status.replaceChildren();
      if (entry.error) {
        status.append(el("p", "assistant-error", t("failed", { message: entry.error.message })), button(t("retry"), "btn ghost", () => void entry.reload()));
      } else if (entry.pending) status.append(el("p", "assistant-empty", t("loading")));
      else if (state.loaded && !state.rows.length) status.append(el("p", "assistant-empty", t("noChats")));
      more.hidden = !state.hasMore; more.disabled = entry.pending;
    }
    function rowNode(entry, row) {
      const item = el("li", `assistant-session-row${row.unread ? " unread" : ""}`);
      item.dataset.session = row.id;
      const open = button("", "assistant-session-open", () => onSelect(entry.profile, row));
      const title = el("strong", "", row.title || t("untitled"));
      open.append(title);
      if (row.preview) open.append(el("p", "assistant-session-preview", row.preview));
      const meta = el("small", "assistant-session-meta");
      meta.append(el("span", "assistant-source", row.source === "cron" ? t("routines") : M.sourceLabel(row.source)),
        el("time", "", M.formatWhen(row.lastActive || row.startedAt, Date.now(), locale)));
      open.append(meta);
      const menu = button("···", "assistant-icon-btn assistant-session-more", () => { actions.hidden = !actions.hidden; menu.setAttribute("aria-expanded", String(!actions.hidden)); });
      menu.setAttribute("aria-label", `${t("moreOptions")} · ${row.title || t("untitled")}`); menu.setAttribute("aria-expanded", "false");
      const actions = el("div", "assistant-history-actions"); actions.hidden = true;
      const error = el("p", "assistant-error"); error.hidden = true;
      function fail(failure) { error.textContent = t("failed", { message: failure.message }); error.hidden = false; }
      const rename = button(t("rename"), "btn ghost", () => {
        actions.replaceChildren();
        const form = el("form", "assistant-history-rename"), input = el("input", "assistant-rename");
        input.value = row.title || ""; input.setAttribute("aria-label", t("rename"));
        const save = button(t("save"), "btn primary", null, "submit");
        form.append(input, save, button(t("cancel"), "btn ghost", () => render(entry)), error);
        form.addEventListener("submit", async event => {
          event.preventDefault(); if (!input.value.trim()) return;
          save.disabled = true; error.hidden = true;
          try { await api.rename(row.id, entry.profile, input.value.trim()); row.title = input.value.trim(); if (active === entry) render(entry); }
          catch (failure) { fail(failure); save.disabled = false; }
        });
        actions.append(form); input.focus();
      });
      let armed = false;
      const remove = button(t("delete"), "btn ghost assistant-danger", async () => {
        if (!armed) { armed = true; remove.textContent = t("confirmDelete"); setTimeout(() => { armed = false; remove.textContent = t("delete"); }, 4000); return; }
        remove.disabled = true;
        try { await api.remove(row.id, entry.profile); entry.state.rows = entry.state.rows.filter(other => other.id !== row.id); if (active === entry) render(entry); }
        catch (failure) { fail(failure); remove.disabled = false; }
      });
      actions.append(rename, remove, error);
      item.append(open, menu, actions);
      return item;
    }
    return Object.freeze({ open, close });
  }
  root.StepsembleAssistantHistory = Object.freeze({ create });
})(window);
