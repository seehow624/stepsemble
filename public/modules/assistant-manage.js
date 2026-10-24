(function (root) {
  "use strict";

  // Creating Bots and each Bot's Settings tab: look, personality, model,
  // skills (with the Skill Hub), toolsets, MCP servers, and deleting the Bot.
  // Hermes keeps all of it in the Bot's profile; nothing is stored here.

  const MAX_AVATAR = 2_000_000;

  function create({ api, t, el, button, toast, M, machineName, bots, onCreated, onDeleted, onChanged }) {
    const failed = error => toast(error?.code === "bot_changed" ? t("botChanged") : t("failed", { message: error.message }));
    function labeled(label, ...nodes) {
      const wrap = el("label", "assistant-field");
      wrap.append(el("span", "", label), ...nodes);
      return wrap;
    }
    function input(value = "", type = "text") {
      const node = el("input");
      node.type = type;
      node.value = value;
      return node;
    }
    function checkbox(label, checked, onChange) {
      const wrap = el("label", "assistant-check");
      const box = el("input");
      box.type = "checkbox";
      box.checked = checked;
      box.addEventListener("change", async () => {
        box.disabled = true;
        try { await onChange(box.checked); } catch (error) { box.checked = !box.checked; failed(error); } finally { box.disabled = false; }
      });
      wrap.append(box, el("span", "", label));
      return wrap;
    }
    function section(title, open = false) {
      const details = el("details", "assistant-manage-section");
      details.open = open;
      details.append(el("summary", "", title));
      return details;
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
        try { await action(); } catch (error) { failed(error); node.disabled = false; }
      });
      return node;
    }
    // Follows a Hermes background action (Skill Hub install or uninstall).
    async function follow(action) {
      if (!action) return true;
      for (let tries = 0; tries < 240; tries += 1) {
        const status = await api.skillAction(action);
        if (!status.running) {
          if (status.exitCode === 0 || status.exitCode === null) return true;
          throw new Error(status.lines.at(-1) || `exit ${status.exitCode}`);
        }
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
      throw new Error("timed out");
    }

    // ---- a new Bot ----------------------------------------------------------

    function creator(container, onCancel) {
      const form = el("form", "assistant-routine-form assistant-bot-form");
      const title = input();
      const id = input();
      id.pattern = "[a-z0-9][a-z0-9_-]{0,63}";
      id.autocapitalize = "none";
      id.spellcheck = false;
      let idEdited = false;
      title.addEventListener("input", () => { if (!idEdited) id.value = M.profileIdFor(title.value); sync(); });
      id.addEventListener("input", () => { idEdited = true; sync(); });
      const description = input();
      const from = el("select");
      for (const [value, label] of [["", t("startFresh")], ...bots().map(bot => [bot.name, t("copyOf", { name: bot.displayName })])]) {
        const option = el("option", "", label);
        option.value = value;
        from.append(option);
      }
      const soul = el("textarea");
      soul.rows = 5;
      const color = input("#5b8def", "color");
      const error = el("p", "assistant-error");
      error.hidden = true;
      const submit = button(t("createBot"), "btn primary", null, "submit");
      const sync = () => { submit.disabled = !title.value.trim() || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id.value); };
      const actions = el("div", "assistant-ask-actions");
      actions.append(submit, button(t("cancel"), "btn ghost", onCancel));
      const idField = labeled(t("botIdLabel"), id);
      idField.append(el("small", "", t("botIdHint")));
      form.append(el("h2", "", t("newBot")), labeled(t("botTitle"), title), idField, labeled(t("botDescription"), description),
        labeled(t("copyFrom"), from), labeled(t("personality"), soul), labeled(t("botColor"), color), error, actions);
      form.addEventListener("submit", async event => {
        event.preventDefault();
        submit.disabled = true;
        error.hidden = true;
        try {
          const created = await api.createBot({ name: id.value, title: title.value.trim(), description: description.value.trim(), soul: soul.value,
            color: color.value, cloneFrom: from.value || undefined });
          onCreated(created.name);
        } catch (failure) {
          error.textContent = t("failed", { message: failure.message });
          error.hidden = false;
          sync();
        }
      });
      sync();
      const page = el("section", "assistant-roster");
      page.append(form);
      container.replaceChildren(page);
      title.focus();
    }

    // ---- a Bot's settings ---------------------------------------------------

    async function settings(container, profile) {
      container.replaceChildren(el("p", "assistant-empty", t("loading")));
      let bot;
      try { bot = await api.botDescribe(profile); } catch (error) {
        container.replaceChildren(el("p", "assistant-error", t("failed", { message: error.message })));
        return;
      }
      const wrap = el("div", "assistant-manage");
      wrap.append(lookSection(bot), soulSection(bot), modelSection(bot), skillsSection(bot), toggles(t("toolsTitle"), bot.toolsets, "enabledToolsets", bot),
        toggles(t("mcpTitle"), bot.mcpServers, "enabledMcpServers", bot));
      if (!bot.isDefault) wrap.append(deleteSection(bot));
      container.replaceChildren(wrap);
    }

    function lookSection(bot) {
      const box = section(t("look"), true);
      const title = input(bot.title), description = input(bot.description), color = input(bot.color || "#5b8def", "color");
      const A = root.StepsembleAssistantAvatars;
      const picture = el("span", "assistant-avatar assistant-manage-avatar");
      const picker = el("fieldset", "assistant-avatar-picker"), choices = new Map();
      picker.append(el("legend", "", t("presetAvatars")));
      let image = null, savingAvatar = false;
      const file = el("input"); file.type = "file"; file.accept = "image/png,image/jpeg,image/webp"; file.hidden = true;
      const upload = button(t("uploadAvatar"), "btn ghost", () => file.click());
      const usePicture = button(t("useUploadedAvatar"), "btn ghost", () => void updateAvatar(async () => {
        await api.configureBot(bot.name, { avatarPreset: null }); bot.avatarPreset = null;
      }));
      const removePicture = button(t("removeAvatar"), "btn ghost", () => void updateAvatar(async () => {
        await api.setBotAvatar(bot.name, null); image = null; bot.hasAvatar = false;
      }));
      function syncAvatar() {
        A.paint(picture, bot, image);
        const selected = A.resolve(bot);
        for (const [id, radio] of choices) {
          radio.checked = selected.kind === "preset" && selected.id === id;
          radio.disabled = savingAvatar && radio !== document.activeElement;
        }
        upload.disabled = usePicture.disabled = removePicture.disabled = savingAvatar;
        usePicture.hidden = !bot.hasAvatar || selected.kind === "custom";
        removePicture.hidden = !bot.hasAvatar;
        picker.setAttribute("aria-busy", String(savingAvatar));
      }
      async function updateAvatar(action) {
        if (savingAvatar) return;
        savingAvatar = true; syncAvatar();
        try { await action(); onChanged(bot.name); }
        catch (error) { failed(error); }
        finally { savingAvatar = false; syncAvatar(); }
      }
      const titles = { abstract: "avatarAbstract", letters: "avatarLetters", characters: "avatarCharacters", elements: "avatarElements" };
      const label = preset => preset.group === "elements" ? t(`element${preset.name[0].toUpperCase()}${preset.name.slice(1)}`) : preset.name;
      for (const group of A.groups) {
        const box = el("div", "assistant-avatar-group"), heading = el("p", "assistant-avatar-group-title", t(titles[group.id])), grid = el("div", "assistant-avatar-grid");
        heading.id = `assistant-avatar-${group.id}-${bot.name}`;
        box.dataset.group = group.id; box.setAttribute("role", "group"); box.setAttribute("aria-labelledby", heading.id);
        for (const preset of group.presets) {
          const option = el("label", "assistant-avatar-option"), radio = el("input", "assistant-avatar-radio");
          option.dataset.preset = preset.id; option.title = label(preset);
          radio.type = "radio"; radio.name = `avatar-${bot.name}`; radio.value = preset.id;
          radio.setAttribute("aria-label", option.title);
          radio.addEventListener("change", () => { if (radio.checked) void updateAvatar(async () => {
            await api.configureBot(bot.name, { avatarPreset: preset.id }); bot.avatarPreset = preset.id;
          }); });
          option.append(radio, A.paint(el("span", "assistant-avatar"), { name: bot.name, avatarPreset: preset.id }, null, { lazy: true }));
          choices.set(preset.id, radio); grid.append(option);
        }
        box.append(heading, grid); picker.append(box);
      }
      file.addEventListener("change", () => {
        const chosen = file.files?.[0]; file.value = "";
        if (!chosen || savingAvatar) return;
        if (!["image/png", "image/jpeg", "image/webp"].includes(chosen.type) || chosen.size > MAX_AVATAR) { toast(t("avatarTooLarge")); return; }
        void updateAvatar(async () => {
          const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(chosen);
          });
          await api.setBotAvatar(bot.name, data); image = data; bot.hasAvatar = true; bot.avatarPreset = null;
        });
      });
      const pictureRow = el("div", "assistant-manage-picture"), pictureActions = el("div", "assistant-avatar-actions");
      pictureActions.append(upload, usePicture, removePicture); pictureRow.append(picture, pictureActions, file);
      syncAvatar();
      if (bot.hasAvatar) void api.botAvatar(bot.name).then(result => { image = result.data; syncAvatar(); }).catch(() => {});
      const hidden = checkbox(t("hideBot"), bot.hidden, async checked => { await api.configureBot(bot.name, { hidden: checked }); bot.hidden = checked; onChanged(bot.name); });
      const save = button(t("save"), "btn primary", async () => {
        const changes = {};
        if (title.value.trim() !== bot.title) changes.title = title.value.trim();
        if (description.value.trim() !== bot.description) changes.description = description.value.trim();
        if (color.value !== (bot.color || "#5b8def")) changes.color = color.value;
        if (!Object.keys(changes).length) return;
        save.disabled = true;
        try {
          await api.configureBot(bot.name, changes);
          Object.assign(bot, { title: changes.title ?? bot.title, description: changes.description ?? bot.description, color: changes.color ?? bot.color });
          if (changes.title) { bot.displayName = changes.title; syncAvatar(); }
          toast(t("saved"));
          onChanged(bot.name);
        } catch (error) { failed(error); } finally { save.disabled = false; }
      });
      box.append(pictureRow, picker, labeled(t("botTitle"), title), labeled(t("botDescription"), description), labeled(t("botColor"), color), hidden, save);
      return box;
    }

    function soulSection(bot) {
      const box = section(t("personality"));
      const soul = el("textarea", "assistant-manage-text");
      soul.rows = 12;
      soul.value = bot.soul;
      soul.setAttribute("aria-label", t("personality"));
      const save = button(t("save"), "btn primary", async () => {
        save.disabled = true;
        try { await api.configureBot(bot.name, { soul: soul.value }); bot.soul = soul.value; toast(t("saved")); } catch (error) { failed(error); } finally { save.disabled = false; }
      });
      box.append(soul, save);
      return box;
    }

    function modelSection(bot) {
      const box = section(t("model"));
      const provider = el("select"), model = el("select");
      provider.setAttribute("aria-label", t("provider"));
      model.setAttribute("aria-label", t("model"));
      const note = el("p", "assistant-hint");
      note.hidden = true;
      const use = button(t("useModel"), "btn primary", () => void apply(false));
      const anyway = button(t("useAnyway"), "btn ghost", () => void apply(true));
      anyway.hidden = true;
      let providers = [];
      const fillModels = selected => {
        const row = providers.find(item => item.slug === provider.value);
        model.replaceChildren(...(row?.models || []).map(name => { const option = el("option", "", name); option.value = name; return option; }));
        if (selected && row?.models.includes(selected)) model.value = selected;
      };
      provider.addEventListener("change", () => { fillModels(null); note.hidden = anyway.hidden = true; });
      model.addEventListener("change", () => { note.hidden = anyway.hidden = true; });
      async function apply(confirmExpensive) {
        use.disabled = anyway.disabled = true;
        try {
          const result = await api.configureBot(bot.name, { model: { provider: provider.value, model: model.value }, confirmExpensive });
          if (result.confirm) { note.textContent = t("confirmModel", { message: result.confirm }); note.hidden = false; anyway.hidden = false; return; }
          note.hidden = anyway.hidden = true;
          bot.model = { provider: provider.value, model: model.value };
          toast(t("saved"));
          onChanged(bot.name);
        } catch (error) { failed(error); } finally { use.disabled = anyway.disabled = false; }
      }
      const actions = el("div", "assistant-ask-actions");
      actions.append(use, anyway);
      box.append(labeled(t("provider"), provider), labeled(t("model"), model), note, actions);
      box.addEventListener("toggle", async () => {
        if (!box.open || providers.length) return;
        try {
          providers = (await api.botModels(bot.name)).providers;
          provider.replaceChildren(...providers.map(row => { const option = el("option", "", row.name); option.value = row.slug; return option; }));
          if (providers.some(row => row.slug === bot.model.provider)) provider.value = bot.model.provider;
          fillModels(bot.model.model);
        } catch (error) { failed(error); }
      });
      return box;
    }

    function toggles(title, rows, key, bot) {
      const box = section(title);
      if (!rows.length) box.append(el("p", "assistant-empty", "—"));
      for (const row of rows) {
        const label = row.label && row.label !== row.name ? `${row.label} · ${row.name}` : row.name;
        box.append(checkbox(label, row.enabled, async checked => {
          const next = rows.map(item => (item === row ? { ...item, enabled: checked } : item));
          await api.configureBot(bot.name, { [key]: next.filter(item => item.enabled).map(item => item.name) });
          row.enabled = checked;
        }));
      }
      return box;
    }

    function skillsSection(bot) {
      const box = section(t("skillsTitle"));
      const list = el("div", "assistant-skill-list");
      const hub = el("div", "assistant-skill-hub");
      box.append(list, el("h3", "", t("skillHub")), hub);
      async function load() {
        list.replaceChildren(el("p", "assistant-empty", t("loading")));
        try { renderSkills((await api.skills(bot.name)).skills); } catch (error) { list.replaceChildren(el("p", "assistant-error", t("failed", { message: error.message }))); }
      }
      function renderSkills(skills) {
        list.replaceChildren();
        if (!skills.length) list.append(el("p", "assistant-empty", t("noSkills")));
        let category = null;
        for (const skill of skills) {
          if (skill.category !== category) { category = skill.category; list.append(el("h4", "assistant-skill-category", category || "—")); }
          const item = el("div", "assistant-skill");
          item.dataset.skill = skill.name;
          const head = el("div", "assistant-skill-head");
          head.append(checkbox(skill.name, skill.enabled, checked => api.toggleSkill(bot.name, skill.name, checked)));
          const actions = el("div", "assistant-skill-actions");
          actions.append(button(t("editSkill"), "btn ghost", () => void edit(item, skill)));
          if (skill.source === "hub") {
            actions.append(twoTap(t("uninstall"), t("confirmUninstall"), "btn ghost assistant-danger", async () => {
              await follow((await api.uninstallSkill(bot.name, skill.name)).action);
              await load();
            }));
          }
          head.append(actions);
          item.append(head);
          if (skill.description) item.append(el("small", "", skill.description));
          list.append(item);
        }
      }
      async function edit(item, skill) {
        if (item.querySelector(".assistant-skill-editor")) return;
        const editor = el("div", "assistant-skill-editor");
        const text = el("textarea", "assistant-manage-text");
        text.rows = 14;
        text.setAttribute("aria-label", `SKILL.md · ${skill.name}`);
        editor.append(el("p", "assistant-empty", t("loading")));
        item.append(editor);
        try { text.value = (await api.skillContent(bot.name, skill.name)).content; } catch (error) { editor.remove(); failed(error); return; }
        const save = button(t("save"), "btn primary", async () => {
          save.disabled = true;
          try { await api.saveSkill(bot.name, skill.name, text.value); toast(t("saved")); editor.remove(); } catch (error) { failed(error); save.disabled = false; }
        });
        const actions = el("div", "assistant-ask-actions");
        actions.append(save, button(t("cancel"), "btn ghost", () => editor.remove()));
        editor.replaceChildren(text, actions);
        text.focus();
      }

      const search = el("input", "assistant-search");
      search.type = "search"; search.spellcheck = false; search.setAttribute("autocorrect", "off"); search.setAttribute("autocapitalize", "off");
      search.placeholder = t("searchHub");
      search.setAttribute("aria-label", t("searchHub"));
      const results = el("div", "assistant-hub-results");
      let timer = 0, query = "";
      search.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          query = search.value.trim();
          if (!query) { results.replaceChildren(); return; }
          results.replaceChildren(el("p", "assistant-empty", t("loading")));
          try {
            const found = await api.hubSearch(bot.name, query);
            if (search.value.trim() !== query) return;
            results.replaceChildren();
            if (!found.results.length) results.append(el("p", "assistant-empty", t("noResults")));
            for (const row of found.results) results.append(hubRow(row, found.installed.includes(row.identifier)));
          } catch (error) { results.replaceChildren(el("p", "assistant-error", t("failed", { message: error.message }))); }
        }, 400);
      });
      function hubRow(row, installed) {
        const item = el("div", "assistant-skill assistant-hub-row");
        const head = el("div", "assistant-skill-head");
        const copy = el("div");
        copy.append(el("strong", "", row.name), el("small", "", [row.trust, row.source].filter(Boolean).join(" · ")));
        const actions = el("div", "assistant-skill-actions");
        const detail = el("div", "assistant-hub-detail");
        actions.append(button(t("preview"), "btn ghost", async () => {
          if (detail.dataset.kind === "preview") { detail.replaceChildren(); detail.dataset.kind = ""; return; }
          detail.dataset.kind = "preview";
          detail.replaceChildren(el("p", "assistant-empty", t("loading")));
          try { detail.replaceChildren(el("pre", "assistant-ask-command", (await api.hubPreview(bot.name, row.identifier)).skillMd)); } catch (error) { detail.replaceChildren(); failed(error); }
        }));
        if (installed) actions.append(el("span", "assistant-routine-tag", t("installed")));
        else actions.append(button(t("install"), "btn primary", () => void scan()));
        async function scan() {
          detail.dataset.kind = "scan";
          detail.replaceChildren(el("p", "assistant-empty", t("loading")));
          let result;
          try { result = await api.hubScan(bot.name, row.identifier); } catch (error) { detail.replaceChildren(); failed(error); return; }
          const card = el("section", `assistant-ask assistant-scan ${result.policy}`);
          card.append(el("h3", "", t("scanTitle")));
          card.append(el("p", "", result.policy === "allow" ? t("scanAllow") : t(result.policy === "block" ? "scanBlock" : "scanAsk", { reason: result.reason || result.summary })));
          if (result.summary) card.append(el("p", "assistant-empty", result.summary));
          if (result.findings.length) {
            const findings = el("ul", "assistant-scan-findings");
            for (const finding of result.findings) findings.append(el("li", "", `${finding.severity} · ${finding.description}${finding.file ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})` : ""}`));
            card.append(findings);
          }
          if (result.policy !== "block") {
            const go = button(result.policy === "ask" ? t("confirmInstall") : t("install"), "btn primary", async () => {
              go.disabled = true;
              go.textContent = t("installing");
              try {
                await follow((await api.installSkill(bot.name, row.identifier, true)).action);
                detail.replaceChildren();
                actions.lastChild.replaceWith(el("span", "assistant-routine-tag", t("installed")));
                toast(t("installed"));
                await load();
              } catch (error) { failed(error); go.disabled = false; go.textContent = t("install"); }
            });
            card.append(go);
          }
          detail.replaceChildren(card);
        }
        head.append(copy, actions);
        item.append(head);
        if (row.description) item.append(el("small", "", row.description));
        item.append(detail);
        return item;
      }
      hub.append(search, results);
      box.addEventListener("toggle", () => { if (box.open && !list.childElementCount) void load(); });
      return box;
    }

    function deleteSection(bot) {
      const box = section(t("deleteBot"));
      const confirm = input();
      confirm.autocapitalize = "none";
      confirm.spellcheck = false;
      confirm.setAttribute("aria-label", t("deleteBot"));
      const go = button(t("deleteForever"), "btn ghost assistant-danger", async () => {
        go.disabled = true;
        try { await api.deleteBot(bot.name, confirm.value); onDeleted(bot.name); } catch (error) { failed(error); go.disabled = confirm.value !== bot.name; }
      });
      go.disabled = true;
      confirm.addEventListener("input", () => { go.disabled = confirm.value !== bot.name; });
      box.append(el("p", "", t("deleteBotBody", { name: bot.name, computer: machineName() })), confirm, go);
      return box;
    }

    return Object.freeze({ creator, settings });
  }

  root.StepsembleAssistantManage = Object.freeze({ create });
})(window);
