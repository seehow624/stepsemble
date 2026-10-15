(function (root) {
  "use strict";

  // The Hermes console (Settings → Agents & models → Hermes, opened as
  // /assistant.html?view=console): gateway, default model and reasoning,
  // auxiliary models, fallback chain, API keys, custom endpoints and usage.
  // Key values are typed here, sent once to Hermes and the field is cleared;
  // the page only ever shows Hermes's masked preview.

  const REASONING = ["", "none", "minimal", "low", "medium", "high", "xhigh", "max"];

  function create({ api, t, el, button, toast, locale, onBack }) {
    const failed = error => toast(t("failed", { message: error.message }));
    const number = value => new Intl.NumberFormat(locale, { notation: value >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
    const money = value => new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: value < 1 ? 3 : 2 }).format(value);
    function labeled(label, ...nodes) {
      const wrap = el("label", "assistant-field");
      wrap.append(el("span", "", label), ...nodes);
      return wrap;
    }
    function select(options, value, label) {
      const node = el("select");
      for (const [key, text] of options) { const option = el("option", "", text); option.value = key; node.append(option); }
      if (options.some(([key]) => key === value)) node.value = value;
      if (label) node.setAttribute("aria-label", label);
      return node;
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
        if (!armed) { armed = true; node.textContent = confirm; setTimeout(() => { armed = false; node.textContent = label; }, 4000); return; }
        node.disabled = true;
        try { await action(); } catch (error) { failed(error); } finally { node.disabled = false; node.textContent = label; armed = false; }
      });
      return node;
    }
    // A provider + model picker over Hermes's model catalog; a model the
    // catalog does not list (for example one set by hand) stays selectable.
    function modelPicker(providers, current, { auto = false } = {}) {
      const options = [...(auto ? [["auto", t("autoProvider")]] : []), ...providers.map(row => [row.slug, row.name])];
      if (current.provider && !options.some(([key]) => key === current.provider)) options.push([current.provider, current.provider]);
      const provider = select(options, current.provider || (auto ? "auto" : providers[0]?.slug), t("provider"));
      const model = el("select");
      model.setAttribute("aria-label", t("model"));
      const fill = selected => {
        const names = [...(providers.find(row => row.slug === provider.value)?.models || [])];
        if (selected && provider.value === current.provider && !names.includes(selected)) names.unshift(selected);
        model.replaceChildren(...names.map(name => { const option = el("option", "", name); option.value = name; return option; }));
        if (selected && names.includes(selected)) model.value = selected;
        model.hidden = provider.value === "auto";
      };
      provider.addEventListener("change", () => fill(null));
      fill(current.model);
      return { provider, model, value: () => ({ provider: provider.value, model: provider.value === "auto" ? "" : model.value }) };
    }

    async function show(container) {
      // A save redraws the page from Hermes; the sections that were open stay open.
      const opened = new Set([...container.querySelectorAll(".assistant-manage-section[open] > summary")].map(node => node.textContent));
      if (!container.querySelector(".assistant-console")) container.replaceChildren(el("p", "assistant-empty", t("loading")));
      let view;
      try { view = await api.console(); } catch (error) {
        container.replaceChildren(el("p", "assistant-error", t("failed", { message: error.message })));
        return;
      }
      const page = el("section", "assistant-roster assistant-console");
      const head = el("div", "assistant-section-head");
      const back = button("‹", "btn ghost assistant-back", onBack);
      back.setAttribute("aria-label", t("back"));
      head.append(back, el("h1", "", t("consoleTitle")));
      page.append(head, el("p", "assistant-empty assistant-console-note", t("updatesElsewhere")));
      const reload = () => void show(container);
      page.append(gatewaySection(view.gateway), modelSection(view, reload), auxiliarySection(view, reload), fallbackSection(view, reload),
        keysSection(view, reload), endpointsSection(view, reload), usageSection());
      for (const details of page.querySelectorAll(".assistant-manage-section")) {
        if (opened.has(details.querySelector("summary").textContent)) { details.open = true; details.dispatchEvent(new Event("toggle")); }
      }
      container.replaceChildren(page);
    }

    function gatewaySection(gateway) {
      const box = section(t("gateway"), true);
      if (!gateway) { box.append(el("p", "assistant-empty", "—")); return box; }
      const state = el("p", `assistant-gateway-state ${gateway.running ? "ok" : "off"}`, gateway.running ? t("gatewayRunning") : t("gatewayStopped"));
      box.append(state);
      if (gateway.activeSessions) box.append(el("p", "assistant-console-meta", t("activeSessions", { count: gateway.activeSessions })));
      if (gateway.platforms.length) {
        const list = el("ul", "assistant-console-list");
        for (const platform of gateway.platforms) {
          const item = el("li", `assistant-platform ${platform.error ? "error" : ""}`);
          item.append(el("strong", "", platform.name), el("span", "", [platform.state, platform.error].filter(Boolean).join(" · ")));
          list.append(item);
        }
        box.append(list);
      }
      box.append(twoTap(t("restartGateway"), t("confirmRestart"), "btn ghost", async () => {
        await api.restartGateway();
        state.textContent = t("restarting");
        for (let tries = 0; tries < 60; tries += 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          const status = await api.consoleRestartStatus().catch(() => null);
          if (status && !status.running) break;
        }
        toast(t("restarted"));
        const fresh = await api.console().catch(() => null);
        if (fresh?.gateway) box.replaceWith(gatewaySection(fresh.gateway));
      }));
      return box;
    }

    function modelSection(view, reload) {
      const box = section(t("mainModel"));
      const picker = modelPicker(view.providers, view.main);
      const note = el("p", "assistant-hint");
      note.hidden = true;
      const use = button(t("useModel"), "btn primary", () => void apply(false));
      const anyway = button(t("useAnyway"), "btn ghost", () => void apply(true));
      anyway.hidden = true;
      for (const node of [picker.provider, picker.model]) node.addEventListener("change", () => { note.hidden = anyway.hidden = true; });
      async function apply(confirmExpensive) {
        use.disabled = anyway.disabled = true;
        try {
          const { provider, model } = picker.value();
          const result = await api.setMainModel(provider, model, confirmExpensive);
          if (result.confirm) { note.textContent = t("confirmModel", { message: result.confirm }); note.hidden = anyway.hidden = false; return; }
          toast(t("saved"));
          reload();
        } catch (error) { failed(error); } finally { use.disabled = anyway.disabled = false; }
      }
      const reasoning = select(REASONING.map(level => [level, level || t("reasoningDefault")]), view.reasoning || "", t("reasoningLabel"));
      reasoning.addEventListener("change", async () => {
        if (!reasoning.value) return;
        try { await api.setReasoning(reasoning.value); toast(t("saved")); } catch (error) { failed(error); }
      });
      const actions = el("div", "assistant-ask-actions");
      actions.append(use, anyway);
      box.append(labeled(t("provider"), picker.provider), labeled(t("model"), picker.model), note, actions, labeled(t("reasoningLabel"), reasoning));
      return box;
    }

    function auxiliarySection(view, reload) {
      const box = section(t("auxiliaryModels"));
      for (const slot of view.auxiliary) {
        const row = el("div", "assistant-console-slot");
        row.dataset.task = slot.task;
        const picker = modelPicker(view.providers, { provider: slot.provider, model: slot.model }, { auto: true });
        const reasoning = select(REASONING.map(level => [level, level || t("reasoningDefault")]), slot.reasoning || "", t("reasoningLabel"));
        const note = el("p", "assistant-hint");
        note.hidden = true;
        const apply = async confirmExpensive => {
          save.disabled = anyway.disabled = true;
          try {
            const result = await api.setAuxiliaryModel({ task: slot.task, ...picker.value(), reasoning: reasoning.value, confirmExpensive });
            if (result.confirm) { note.textContent = t("confirmModel", { message: result.confirm }); note.hidden = anyway.hidden = false; return; }
            toast(t("saved"));
            reload();
          } catch (error) { failed(error); } finally { save.disabled = anyway.disabled = false; }
        };
        const save = button(t("save"), "btn ghost", () => void apply(false));
        const anyway = button(t("useAnyway"), "btn ghost", () => void apply(true));
        anyway.hidden = true;
        row.append(el("strong", "", slot.label || slot.task), picker.provider, picker.model, reasoning, save, anyway, note);
        box.append(row);
      }
      if (!view.auxiliary.length) box.append(el("p", "assistant-empty", "—"));
      return box;
    }

    function fallbackSection(view, reload) {
      const box = section(t("fallbackChain"));
      box.append(el("p", "assistant-console-meta", t("fallbackHint")));
      const chain = view.fallback.map(row => ({ ...row }));
      const list = el("ol", "assistant-console-chain");
      const save = async () => {
        try { await api.setFallback(chain); toast(t("saved")); reload(); } catch (error) { failed(error); }
      };
      chain.forEach((row, index) => {
        const item = el("li");
        item.append(el("span", "", `${row.model} · ${row.provider}`));
        const move = (delta, label) => {
          const node = button(delta < 0 ? "↑" : "↓", "btn ghost", () => { [chain[index], chain[index + delta]] = [chain[index + delta], chain[index]]; void save(); });
          node.setAttribute("aria-label", label);
          node.disabled = index + delta < 0 || index + delta >= chain.length;
          return node;
        };
        item.append(move(-1, t("moveUp")), move(1, t("moveDown")), button(t("remove"), "btn ghost assistant-danger", () => { chain.splice(index, 1); void save(); }));
        list.append(item);
      });
      box.append(list);
      if (chain.length < 5) {
        const picker = modelPicker(view.providers, { provider: "", model: "" });
        const add = button(t("addFallback"), "btn ghost", () => { chain.push(picker.value()); void save(); });
        const row = el("div", "assistant-console-slot");
        row.append(picker.provider, picker.model, add);
        box.append(row);
      }
      return box;
    }

    function keysSection(view, reload) {
      const box = section(t("apiKeys"));
      box.append(el("p", "assistant-console-meta", t("keysHint")));
      const list = el("ul", "assistant-console-list");
      for (const key of view.keys.filter(row => row.isSet)) {
        const item = el("li");
        item.dataset.key = key.key;
        item.append(el("strong", "", key.key), el("span", "assistant-key-preview", key.preview || "•••"),
          twoTap(t("delete"), t("confirmDelete"), "btn ghost assistant-danger", async () => { await api.removeKey(key.key); reload(); }));
        list.append(item);
      }
      box.append(list);
      const names = view.keys.map(row => [row.key, row.provider ? `${row.key} · ${row.provider}` : row.key]);
      const name = select(names, names.find(([key]) => !view.keys.find(row => row.key === key)?.isSet)?.[0], t("keyName"));
      const value = el("input");
      value.type = "password";
      value.autocomplete = "off";
      value.spellcheck = false;
      value.setAttribute("aria-label", t("keyValue"));
      const save = button(t("save"), "btn primary", async () => {
        const secret = value.value;
        value.value = "";
        if (!secret.trim()) return;
        save.disabled = true;
        try { await api.setKey(name.value, secret); toast(t("saved")); reload(); } catch (error) { failed(error); } finally { save.disabled = false; }
      });
      const form = el("div", "assistant-console-slot");
      form.append(el("strong", "", t("addKey")), name, value, save);
      box.append(form);
      return box;
    }

    function endpointsSection(view, reload) {
      const box = section(t("customEndpoints"));
      const list = el("ul", "assistant-console-list");
      for (const endpoint of view.endpoints) {
        const item = el("li");
        item.dataset.endpoint = endpoint.id;
        const copy = el("div");
        copy.append(el("strong", "", endpoint.name), el("small", "", `${endpoint.model} · ${endpoint.baseUrl}`));
        item.append(copy);
        if (endpoint.active) item.append(el("span", "assistant-routine-tag", t("activeEndpoint")));
        else item.append(button(t("useEndpoint"), "btn ghost", async () => { try { await api.activateEndpoint(endpoint.id); reload(); } catch (error) { failed(error); } }));
        item.append(twoTap(t("delete"), t("confirmDelete"), "btn ghost assistant-danger", async () => { await api.removeEndpoint(endpoint.id); reload(); }));
        list.append(item);
      }
      box.append(list);
      const name = el("input"), url = el("input"), model = el("input"), key = el("input");
      url.type = "url";
      url.placeholder = "http://127.0.0.1:1234/v1";
      key.type = "password";
      key.autocomplete = "off";
      const add = button(t("addEndpoint"), "btn primary", async () => {
        const apiKey = key.value;
        key.value = "";
        add.disabled = true;
        try { await api.saveEndpoint({ name: name.value, baseUrl: url.value, model: model.value, apiKey: apiKey || undefined }); toast(t("saved")); reload(); }
        catch (error) { failed(error); } finally { add.disabled = false; }
      });
      box.append(labeled(t("endpointName"), name), labeled(t("baseUrl"), url), labeled(t("model"), model), labeled(t("endpointKey"), key), add);
      return box;
    }

    function usageSection() {
      const box = section(t("usageTitle"));
      const choices = el("div", "assistant-ask-choices");
      const body = el("div", "assistant-usage");
      let days = 7;
      const load = async () => {
        for (const node of choices.children) node.setAttribute("aria-pressed", String(node.dataset.days === String(days)));
        body.replaceChildren(el("p", "assistant-empty", t("loading")));
        try {
          const usage = await api.consoleUsage(days);
          if (!usage.totals.sessions && !usage.totals.input) { body.replaceChildren(el("p", "assistant-empty", t("noUsage"))); return; }
          const totals = el("dl", "assistant-usage-totals");
          for (const [label, value] of [[t("tokensIn"), number(usage.totals.input)], [t("tokensOut"), number(usage.totals.output)],
            [t("cost"), money(usage.totals.cost)], [t("conversations"), number(usage.totals.sessions)]]) {
            const cell = el("div");
            cell.append(el("dt", "", label), el("dd", "", value));
            totals.append(cell);
          }
          const peak = Math.max(1, ...usage.daily.map(row => row.input + row.output));
          const bars = el("div", "assistant-usage-bars");
          bars.setAttribute("aria-hidden", "true");
          for (const row of usage.daily) {
            const bar = el("span");
            bar.style.height = `${Math.max(2, Math.round(((row.input + row.output) / peak) * 100))}%`;
            bar.title = `${row.day} · ${number(row.input + row.output)}`;
            bars.append(bar);
          }
          const models = el("ul", "assistant-console-list");
          for (const row of usage.byModel) {
            const item = el("li");
            item.append(el("strong", "", row.model), el("span", "", `${number(row.input + row.output)} · ${money(row.cost)}`));
            models.append(item);
          }
          body.replaceChildren(totals, bars, el("h3", "", t("byModel")), models);
        } catch (error) { body.replaceChildren(el("p", "assistant-error", t("failed", { message: error.message }))); }
      };
      for (const value of [7, 30, 90]) {
        const node = button(t("lastDays", { days: value }), "assistant-choice", () => { days = value; void load(); });
        node.dataset.days = String(value);
        choices.append(node);
      }
      box.append(choices, body);
      box.addEventListener("toggle", () => { if (box.open && !body.childElementCount) void load(); });
      return box;
    }

    return Object.freeze({ show });
  }

  root.StepsembleAssistantConsole = Object.freeze({ create });
})(window);
