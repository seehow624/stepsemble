(function (root) {
  "use strict";

  // First-run guidance for the assistant page. Before the first Hermes
  // sign-in it explains where the dashboard username and password come from;
  // after the first sign-in it introduces the page once. Each is shown once
  // per browser and the sign-in guide can be reopened from the form.

  const KEY = "stepsemble.assistant.guide.v1";
  const DOCS = "https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard#usernamepassword-provider-no-oauth-idp";

  function read() { try { return JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { return {}; } }
  const seen = name => read()[name] === true;
  function mark(name) { try { localStorage.setItem(KEY, JSON.stringify({ ...read(), [name]: true })); } catch {} }

  function create({ t, el, button }) {
    // A command or path to type on the Hermes computer, with a copy button.
    // Clipboard access needs a secure page; elsewhere the text is selected.
    function code(text) {
      const row = el("div", "assistant-code");
      const value = el("code", "", text);
      const copy = button(t("copy"), "assistant-code-copy", async () => {
        try {
          await navigator.clipboard.writeText(text);
          copy.textContent = t("copied");
          setTimeout(() => { copy.textContent = t("copy"); }, 1600);
        } catch {
          const range = document.createRange();
          range.selectNodeContents(value);
          getSelection().removeAllRanges();
          getSelection().addRange(range);
        }
      });
      row.append(value, copy);
      return row;
    }

    function progress(step, total) {
      const bar = el("div", "assistant-steps-bar");
      bar.setAttribute("aria-hidden", "true");
      for (let index = 0; index < total; index += 1) bar.append(el("span", index <= step ? "on" : ""));
      return bar;
    }

    // Three short steps that end at the sign-in form.
    function setup({ computer, onDone }) {
      const card = el("section", "assistant-card assistant-guide");
      card.setAttribute("aria-live", "polite");
      const steps = [
        () => [el("h1", "", t("guideConnectTitle")), el("p", "", t("guideConnectBody", { computer }))],
        () => [el("h1", "", t("guideFindTitle")), el("p", "", t("guideFindBody", { computer })), code("~/.hermes/config.yaml"),
          el("p", "assistant-guide-note", t("guideFindNote"))],
        () => {
          const docs = el("a", "assistant-guide-link", t("guideDocs"));
          docs.href = DOCS;
          docs.target = "_blank";
          docs.rel = "noopener";
          return [el("h1", "", t("guideResetTitle")), el("p", "", t("guideResetBody", { computer })), code("hermes dashboard --host 0.0.0.0"),
            el("p", "assistant-guide-note", t("guideResetNote")), docs];
        },
      ];
      let step = 0;
      const draw = () => {
        const last = step === steps.length - 1;
        const actions = el("div", "assistant-guide-actions");
        if (step > 0) actions.append(button(t("back"), "btn ghost", () => { step -= 1; draw(); }));
        else actions.append(button(t("skip"), "assistant-link", onDone));
        const next = button(last ? t("guideReady") : t("next"), "btn primary", () => { if (last) onDone(); else { step += 1; draw(); } });
        actions.append(next);
        card.replaceChildren(progress(step, steps.length), el("p", "assistant-eyebrow", t("guideStep", { step: step + 1, total: steps.length })),
          ...steps[step](), actions);
        next.focus();
      };
      draw();
      return card;
    }

    // A small, inert picture of what each part of the page looks like, built
    // from the page's own pieces so it always matches the theme.
    function preview(kind, bots, avatar) {
      const box = el("div", `assistant-intro-preview ${kind}`);
      box.setAttribute("aria-hidden", "true");
      const names = bots.map(bot => bot.displayName);
      if (kind === "bots") {
        const faces = el("div", "assistant-intro-faces");
        for (const bot of bots.slice(0, 5)) faces.append(avatar(bot));
        box.append(faces);
      } else if (kind === "ask") {
        const card = el("div", "assistant-ask");
        card.append(el("h3", "", t("approvalTitle", { bot: names[0] || "Hermes" })), el("div", "assistant-ask-command", "git push origin main"));
        const actions = el("div", "assistant-ask-actions");
        actions.append(el("span", "btn primary small", t("once")), el("span", "btn ghost small assistant-danger", t("deny")));
        card.append(actions);
        box.append(card);
      } else if (kind === "groups") {
        const chips = el("div", "assistant-group-mentions");
        for (const bot of bots.slice(0, 2)) chips.append(el("span", "assistant-choice", `@${bot.name}`));
        chips.append(el("span", "assistant-choice", "@all"));
        box.append(chips);
      } else {
        const menu = el("div", "assistant-intro-menu");
        for (const label of [t("historyAction"), t("routines"), t("settings")]) menu.append(el("span", "", label));
        box.append(menu);
      }
      return box;
    }

    // The one-time introduction after the first sign-in, over the page.
    function intro({ bots, avatar, onDone }) {
      const layer = el("div", "assistant-intro");
      const card = el("section", "assistant-card assistant-intro-card");
      card.setAttribute("role", "dialog");
      card.setAttribute("aria-modal", "true");
      card.setAttribute("aria-labelledby", "assistant-intro-title");
      layer.append(card);
      const pages = [["bots", "introTitle1", "introBody1"], ["ask", "introTitle2", "introBody2"], ["groups", "introTitle3", "introBody3"], ["settings", "introTitle4", "introBody4"]];
      let page = 0;
      const opener = document.activeElement, covered = new Map();
      for (const node of document.querySelectorAll(".assistant-top, .assistant-main")) { covered.set(node, node.inert); node.inert = true; }
      const close = () => {
        document.removeEventListener("keydown", keys, true); layer.remove();
        for (const [node, value] of covered) node.inert = value;
        if (opener?.isConnected) opener.focus();
        onDone();
      };
      const keys = event => {
        if (event.key === "Escape") { event.preventDefault(); close(); }
        if (event.key === "Tab") {
          const buttons = [...card.querySelectorAll("button")], first = buttons[0], last = buttons.at(-1);
          if (!card.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
          else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      };
      const draw = () => {
        const [kind, title, body] = pages[page], last = page === pages.length - 1;
        const heading = el("h1", "", t(title));
        heading.id = "assistant-intro-title";
        const actions = el("div", "assistant-guide-actions");
        const next = button(last ? t("introStart") : t("next"), "btn primary assistant-intro-next", () => { if (last) close(); else { page += 1; draw(); } });
        actions.append(last ? el("span") : button(t("skip"), "assistant-link", close), next);
        card.replaceChildren(preview(kind, bots, avatar), progress(page, pages.length), heading, el("p", "", t(body)), actions);
        next.focus();
      };
      document.addEventListener("keydown", keys, true);
      document.body.append(layer);
      draw();
      return layer;
    }

    return Object.freeze({ setup, intro });
  }

  root.StepsembleAssistantGuide = Object.freeze({ create, seen, mark, DOCS });
})(window);
