(function (root) {
  "use strict";
  // Enter in a text field, unless an input method used it to confirm text (composer-ime.js).
  const isEnter = event => !!root.stepsembleComposerIme?.isEnter(event);

  // Group chats: Hermes hosted rooms of local Bots. Hermes decides who speaks
  // and reads @mentions; this view shows the room log, sends messages, and
  // answers the approvals a member raises. While a room is open and visible
  // it reads new events every 1.5 s and the room state every 3 s.

  function create({ api, t, el, button, iconButton, toast, avatar, markdown, bots, onBack, drafts = new Map() }) {
    let open = null;
    const colorOf = profile => bots().find(bot => bot.name === profile)?.color;
    const failed = error => toast(t("failed", { message: error.message }));

    function section(data, onOpen, onNew, current = null) {
      const wrap = el("section", "assistant-groups");
      const head = el("div", "assistant-section-head");
      head.append(el("h2", "", t("groups")));
      if (data.supported) head.append(iconButton("plus", t("newGroup"), "assistant-new-group", onNew));
      wrap.append(head);
      if (!data.supported) { wrap.append(el("p", "assistant-empty", t("groupsUnsupported"))); return wrap; }
      if (!data.rooms.length) wrap.append(el("p", "assistant-empty", t("noGroups")));
      const list = el("ul", "assistant-bot-list");
      for (const room of data.rooms) {
        const row = button("", "assistant-bot-row assistant-group-row", () => onOpen(room));
        if (room.id === current) row.setAttribute("aria-current", "true");
        const faces = el("span", "assistant-group-faces");
        for (const member of room.members.slice(0, 3)) faces.append(avatar({ name: member.profile, displayName: member.displayName, color: colorOf(member.profile) }));
        const copy = el("span", "assistant-bot-copy");
        copy.append(el("strong", "", room.name), el("small", "", room.members.map(member => member.displayName).join(", ")));
        row.append(faces, copy);
        const item = el("li");
        item.append(row);
        list.append(item);
      }
      wrap.append(list);
      return wrap;
    }

    function picker(container, onOpen) {
      close();
      const form = el("form", "assistant-routine-form assistant-group-form");
      const name = el("input");
      const nameField = el("label", "assistant-field");
      nameField.append(el("span", "", t("groupName")), name);
      const members = el("fieldset", "assistant-routine-deliver");
      members.append(el("legend", "", t("pickMembers")));
      const boxes = bots().map(bot => {
        const wrap = el("label", "assistant-check");
        const box = el("input");
        box.type = "checkbox";
        box.value = bot.name;
        wrap.append(box, el("span", "", bot.displayName));
        members.append(wrap);
        return { box, bot };
      });
      const error = el("p", "assistant-error");
      error.hidden = true;
      const submit = button(t("createGroup"), "btn primary", null, "submit");
      const sync = () => {
        const count = boxes.filter(item => item.box.checked).length;
        submit.disabled = !name.value.trim() || count < 2 || count > 6;
      };
      for (const item of boxes) item.box.addEventListener("change", sync);
      name.addEventListener("input", sync);
      const actions = el("div", "assistant-ask-actions");
      actions.append(submit, button(t("cancel"), "btn ghost", onBack));
      form.append(el("h2", "", t("newGroup")), nameField, members, error, actions);
      form.addEventListener("submit", async event => {
        event.preventDefault();
        submit.disabled = true;
        error.hidden = true;
        try {
          const chosen = boxes.filter(item => item.box.checked).map(item => ({ profile: item.bot.name, displayName: item.bot.displayName }));
          onOpen((await api.createGroup(name.value.trim(), chosen)).room);
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
      name.focus();
    }

    function eventNode(room, event) {
      const member = room.members.find(row => row.memberId === event.memberId);
      const who = member?.displayName || event.memberId || "";
      if (event.kind === "message.user") {
        const node = el("div", "assistant-msg user");
        node.append(el("div", "assistant-bubble", event.text));
        return node;
      }
      if (event.kind === "message.member") {
        const node = el("div", "assistant-msg assistant assistant-group-message");
        const body = el("div", "assistant-reply");
        body.append(el("strong", "assistant-group-author", who), markdown(event.text));
        node.append(avatar({ name: member?.profile || who, displayName: who, color: colorOf(member?.profile) }), body);
        return node;
      }
      const note = { "turn.failed": t("turnFailed", { name: who }), "member.unavailable": t("memberUnavailable", { name: who }),
        "room.renamed": t("renamedTo", { name: event.name }), "room.stop_requested": t("stopRequested") }[event.kind];
      return note ? el("div", "assistant-msg system", note) : null;
    }

    function view(container, room) {
      close();
      const state = { room, cursor: 0, timers: new Map(), working: false, approvals: [], retries: [] };
      open = state;
      const wrap = el("section", "assistant-bot assistant-group");
      const head = el("header", "assistant-bot-head");
      const back = iconButton("back", t("back"), "assistant-back to-list", () => { close(); onBack(); });
      const title = el("div", "assistant-bot-title");
      const name = el("strong", "", room.name);
      title.append(name, el("small", "", room.members.map(member => member.displayName).join(", ")));
      const faces = el("span", "assistant-group-faces");
      for (const member of room.members.slice(0, 3)) faces.append(avatar({ name: member.profile, displayName: member.displayName, color: colorOf(member.profile) }));
      const rename = button(t("rename"), "btn ghost small", () => {
        const input = el("input", "assistant-rename");
        input.value = state.room.name;
        input.setAttribute("aria-label", t("rename"));
        let done = false;
        const save = async () => {
          if (done) return;
          done = true;
          const value = input.value.trim();
          if (value && value !== state.room.name) {
            try { state.room = (await api.groupRename(room.id, value)).room || { ...state.room, name: value }; } catch (error) { failed(error); }
          }
          name.textContent = state.room.name;
          input.replaceWith(name);
        };
        input.addEventListener("keydown", event => { if (isEnter(event)) { event.preventDefault(); void save(); } });
        input.addEventListener("blur", () => void save());
        name.replaceWith(input);
        input.focus();
      });
      let armed = false;
      const disband = button(t("disband"), "btn ghost small assistant-danger", async () => {
        if (!armed) {
          armed = true;
          disband.textContent = t("confirmDisband");
          setTimeout(() => { armed = false; disband.textContent = t("disband"); }, 4000);
          return;
        }
        disband.disabled = true;
        try { await api.groupDisband(room.id); close(); onBack(); } catch (error) { failed(error); disband.disabled = false; }
      });
      const tools = el("div", "assistant-group-tools");
      tools.append(rename, disband);
      head.append(back, faces, title, tools);
      const transcript = el("div", "assistant-transcript");
      const live = el("div", "assistant-group-live");
      const form = el("form", "assistant-composer");
      const mentions = el("div", "assistant-group-mentions");
      const input = el("textarea", "assistant-input");
      input.rows = 1;
      input.value = drafts.get(room.id) || "";
      state.input = input;
      input.addEventListener("input", () => drafts.set(room.id, input.value));
      input.placeholder = t("messageGroup");
      input.setAttribute("aria-label", t("messageGroup"));
      for (const handle of [...room.members.map(member => member.handle), "all"]) {
        mentions.append(button(`@${handle}`, "assistant-choice", () => {
          const text = input.value.replace(/\s*$/, "");
          input.value = `${text}${text ? " " : ""}@${handle} `;
          drafts.set(room.id, input.value);
          input.focus();
        }));
      }
      const stop = iconButton("stop", t("stop"), "assistant-stop", async () => { try { await api.groupStop(room.id); await pollState(); } catch (error) { failed(error); } });
      const send = iconButton("send", t("send"), "assistant-send", null, "submit");
      const row = el("div", "assistant-composer-row");
      row.append(input, stop, send);
      form.append(mentions, row, el("p", "assistant-group-hint", t("mentionHint")));
      form.addEventListener("submit", async event => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text || send.disabled) return;
        send.disabled = true;
        try {
          await api.groupSend(room.id, text);
          input.value = "";
          if (drafts.get(room.id)?.trim() === text) drafts.delete(room.id);
          state.working = true;
          renderLive();
          await pollLog();
        } catch (error) { failed(error); } finally { send.disabled = false; }
      });
      input.addEventListener("keydown", event => {
        if (isEnter(event) && !event.shiftKey && !matchMedia("(pointer: coarse)").matches) { event.preventDefault(); form.requestSubmit(); }
      });
      wrap.append(head, transcript, live, form);
      container.replaceChildren(wrap);

      function renderLive() {
        stop.hidden = !state.working;
        live.replaceChildren();
        if (state.working && !state.approvals.length) live.append(el("p", "assistant-working", t("working")));
        for (const approval of state.approvals) {
          const member = state.room.members.find(row => row.memberId === approval.memberId);
          const card = el("section", "assistant-ask assistant-ask-approval");
          card.append(el("h3", "", t("approvalTitle", { bot: member?.displayName || approval.memberId })));
          if (approval.command) card.append(el("pre", "assistant-ask-command", approval.command));
          if (approval.description) card.append(el("p", "", approval.description));
          const actions = el("div", "assistant-ask-actions");
          const lock = value => { for (const node of actions.querySelectorAll("button")) node.disabled = value; };
          for (const choice of approval.choices) {
            actions.append(button(t(choice), choice === "deny" ? "btn ghost" : "btn primary", async () => {
              lock(true);
              try { await api.groupApprove(room.id, approval, choice); await pollState(); } catch (error) { failed(error); lock(false); }
            }));
          }
          card.append(actions);
          live.append(card);
        }
        for (const retry of state.retries) {
          live.append(button(t("retryTurn"), "btn ghost", async () => { try { await api.groupRetry(room.id, retry.taskId); await pollState(); } catch (error) { failed(error); } }));
        }
      }
      async function pollLog() {
        if (open !== state) return;
        try {
          const page = await api.groupLog(room.id, state.cursor);
          if (open !== state) return;
          const pinned = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
          for (const event of page.events) {
            if (event.seq <= state.cursor) continue;
            const node = eventNode(state.room, event);
            if (node) transcript.append(node);
            if (event.kind === "room.renamed" && event.name) { state.room = { ...state.room, name: event.name }; name.textContent = event.name; }
          }
          state.cursor = Math.max(state.cursor, page.cursor);
          if (pinned && page.events.length) transcript.scrollTop = transcript.scrollHeight;
          if (page.hasMore) await pollLog();
        } catch (error) {
          if (error.status === 404 && open === state) { close(); onBack(); }
        }
      }
      async function pollState() {
        if (open !== state) return;
        try {
          const next = await api.groupState(room.id);
          if (open !== state) return;
          Object.assign(state, { working: next.working, approvals: next.approvals, retries: next.retries, room: next.room || state.room });
          renderLive();
        } catch {}
      }
      // Each loop waits for its own request before scheduling the next one,
      // and pauses while the page is hidden.
      const every = (fn, ms) => {
        const loop = async () => {
          if (open !== state) return;
          if (document.visibilityState === "visible") await fn();
          if (open === state) state.timers.set(fn, setTimeout(loop, ms));
        };
        void loop();
      };
      renderLive();
      every(pollLog, 1500);
      every(pollState, 3000);
      input.focus();
    }

    function close() {
      if (!open) return;
      if (open.input) drafts.set(open.room.id, open.input.value);
      for (const timer of open.timers.values()) clearTimeout(timer);
      open = null;
    }

    return Object.freeze({ load: () => api.groups(), section, picker, view, close });
  }

  root.StepsembleAssistantGroups = Object.freeze({ create });
})(window);
