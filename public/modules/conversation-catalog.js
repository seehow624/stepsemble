"use strict";
/// <reference path="./pi-session.ts" />
/// <reference path="./agent-identity.ts" />
/** A presentation index, not a new source reader or a resume/approval grant.
 * Never match sessions by title, model, cwd, timestamp or an ID from another Host. */
var StepsembleConversations;
(function (StepsembleConversations) {
    StepsembleConversations.LIMITS = Object.freeze({ sessions: 10000, tasks: 256, page: 50, text: 500, reference: 4096 });
    const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
    const text = (v, max = StepsembleConversations.LIMITS.text) => typeof v === "string" ? v.slice(0, max).replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
    const ref = (v) => typeof v === "string" && v.length > 0 && v.length <= StepsembleConversations.LIMITS.reference && !/[\u0000-\u001f\u007f]/.test(v) ? v : "";
    const timestamp = (v) => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
    const states = new Set(["starting", "running", "reconnecting", "waiting", "completed", "failed", "stopped", "detached", "orphaned"]);
    StepsembleConversations.active = (entry) => ["starting", "running", "reconnecting", "waiting"].includes(entry.status);
    StepsembleConversations.identity = (hostId, kind, reference) => JSON.stringify([hostId, kind, reference]);
    function build(hostId, sessions, tasks) {
        if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(hostId))
            throw new TypeError("conversation_host_invalid");
        if (!Array.isArray(sessions) || !Array.isArray(tasks))
            throw new TypeError("conversation_snapshot_invalid");
        const rows = new Map(), ambiguous = new Set();
        let omitted = Math.max(0, sessions.length - StepsembleConversations.LIMITS.sessions) + Math.max(0, tasks.length - StepsembleConversations.LIMITS.tasks);
        function insert(row) {
            if (ambiguous.has(row.key)) {
                omitted++;
                return;
            }
            if (rows.has(row.key)) {
                rows.delete(row.key);
                ambiguous.add(row.key);
                omitted += 2;
                return;
            }
            rows.set(row.key, row);
        }
        for (const raw of sessions.slice(0, StepsembleConversations.LIMITS.sessions)) {
            // /api/sessions is a Pi-only endpoint. An explicit foreign source must
            // not gain the Pi open route just because it arrived in the same array.
            if (!object(raw) || !ref(raw.file) || raw.agentId !== undefined && raw.agentId !== "pi") {
                omitted++;
                continue;
            }
            const reference = ref(raw.file);
            insert({ key: StepsembleConversations.identity(hostId, "pi_history", reference), hostId, reference, agentId: "pi",
                title: text(StepsemblePiSession.title(raw)), project: text(raw.cwd), kind: "pi_history",
                updatedAt: timestamp(raw.mtimeMs), status: raw.isRunning === true ? "running" : "history", temporary: raw.isTemporary === true });
        }
        for (const raw of tasks.slice(0, StepsembleConversations.LIMITS.tasks)) {
            if (!object(raw) || !ref(raw.id ?? raw.taskId)) {
                omitted++;
                continue;
            }
            const reference = ref(raw.id ?? raw.taskId), agentId = StepsembleAgentIdentity.lookup(raw.agentId).id;
            const file = raw.agentId === "pi" ? ref(raw.file) || ref(raw.sessionFile) : "";
            // Only exact Pi file identity on this Host deduplicates the live task.
            // Its process exit is NOT the outcome/name of the saved conversation.
            if (file && (rows.has(StepsembleConversations.identity(hostId, "pi_history", file)) || ambiguous.has(StepsembleConversations.identity(hostId, "pi_history", file))))
                continue;
            insert({ key: StepsembleConversations.identity(hostId, "task_record", reference), hostId, reference, agentId,
                title: text(raw.agentId === "pi" ? StepsemblePiSession.title({ ...raw, name: raw.sessionName ?? raw.name }) : raw.name) || StepsembleAgentIdentity.lookup(raw.agentId).label,
                project: text(raw.cwd), kind: "task_record", updatedAt: timestamp(raw.lastActivityAt) || timestamp(raw.startedAt),
                status: typeof raw.status === "string" && states.has(raw.status) ? raw.status : "unknown", temporary: false });
        }
        return { entries: [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.key.localeCompare(b.key)), omitted };
    }
    StepsembleConversations.build = build;
    function select(snapshot, options = {}) {
        const query = text(options.query, 200).toLocaleLowerCase();
        const matches = snapshot.entries.filter(row => (options.includeTemporary || !row.temporary)
            && (!options.agentId || options.agentId === "all" || row.agentId === options.agentId)
            && (!options.kind || options.kind === "all" || (options.kind === "active" ? StepsembleConversations.active(row) : row.kind === options.kind))
            && (!query || [row.title, row.project, StepsembleAgentIdentity.lookup(row.agentId).label].some(v => v.toLocaleLowerCase().includes(query))));
        const pages = Math.max(1, Math.ceil(matches.length / StepsembleConversations.LIMITS.page));
        const page = Math.min(pages - 1, Number.isSafeInteger(options.page) && options.page >= 0 ? options.page : 0);
        return { entries: matches.slice(page * StepsembleConversations.LIMITS.page, (page + 1) * StepsembleConversations.LIMITS.page), total: matches.length, page, pages };
    }
    StepsembleConversations.select = select;
    /** Native modal focus containment; only 50 row buttons exist at a time.
     * Refresh offers an explicit snapshot update rather than moving rows under a
     * pointer/keyboard focus whenever the background task poll arrives. */
    function createView(deps) {
        const { dialog, t } = deps, doc = dialog.ownerDocument;
        const el = (tag, value = "", cls = "") => {
            const node = doc.createElement(tag);
            node.textContent = value;
            if (cls)
                node.className = cls;
            return node;
        };
        const heading = el("div", "", "conversation-heading"), title = el("h2");
        title.id = "conversation-title";
        const close = el("button");
        close.type = "button";
        close.addEventListener("click", () => dialog.close());
        heading.append(title, close);
        const scope = el("p", "", "conversation-scope"), note = el("p", "", "conversation-note");
        const toolbar = el("div", "", "conversation-toolbar"), search = el("input");
        search.type = "search";
        search.maxLength = 200;
        const agent = el("select"), kind = el("select");
        toolbar.append(search, agent, kind);
        const summary = el("p", "", "conversation-summary");
        summary.setAttribute("role", "status");
        summary.setAttribute("aria-live", "polite");
        const list = el("div", "", "conversation-rows");
        list.setAttribute("role", "list");
        const footer = el("div", "", "conversation-footer"), previous = el("button"), next = el("button"), refresh = el("button");
        for (const button of [previous, next, refresh])
            button.type = "button";
        footer.append(previous, next, refresh);
        dialog.replaceChildren(heading, scope, note, toolbar, summary, list, footer);
        dialog.setAttribute("aria-labelledby", title.id);
        let snapshot = { entries: [], omitted: 0 }, hostId = "", hostLabel = "", stale = false, busy = false, epoch = 0, page = 0;
        let visible = new Map();
        function render() {
            const result = select(snapshot, { query: search.value, agentId: agent.value, kind: kind.value, page, includeTemporary: true });
            page = result.page;
            title.textContent = t("title");
            close.textContent = t("close");
            scope.textContent = hostLabel;
            note.textContent = t("scope");
            search.placeholder = t("search");
            search.setAttribute("aria-label", t("search"));
            agent.setAttribute("aria-label", t("agent"));
            kind.setAttribute("aria-label", t("kind"));
            list.setAttribute("aria-label", t("title"));
            summary.textContent = t("count", { total: result.total, page: page + 1, pages: result.pages })
                + (stale ? " · " + t("stale") : "") + (snapshot.omitted ? " · " + t("omitted", { count: snapshot.omitted }) : "");
            previous.textContent = t("previous");
            next.textContent = t("next");
            refresh.textContent = t(busy ? "loading" : "refresh");
            previous.disabled = page === 0;
            next.disabled = page + 1 >= result.pages;
            refresh.disabled = busy;
            list.setAttribute("aria-busy", String(busy));
            // Reuse keyed rows when the same page refreshes. Never store native text
            // in HTML, URL attributes, persistent storage, logs or clipboard data.
            const existing = new Map([...list.children].map(node => [node.dataset.key, node]));
            visible = new Map(result.entries.map(row => [row.key, row]));
            for (const row of result.entries) {
                let item = existing.get(row.key);
                existing.delete(row.key);
                if (!item) {
                    item = el("div", "", "conversation-row");
                    item.dataset.key = row.key;
                    item.setAttribute("role", "listitem");
                    const button = el("button");
                    button.type = "button";
                    button.className = "conversation-open";
                    const copy = el("span", "", "conversation-copy");
                    copy.append(el("strong"), el("small"), el("small"));
                    button.append(StepsembleAgentIdentity.create(doc, row.agentId, true), copy);
                    button.addEventListener("click", () => {
                        const current = visible.get(row.key);
                        if (!current || current.hostId !== hostId || busy)
                            return;
                        dialog.close();
                        deps.open(current);
                    });
                    item.append(button);
                }
                const copy = item.querySelector(".conversation-copy");
                const badge = item.querySelector(".agent-logo");
                if (badge && badge.dataset.agentId !== row.agentId)
                    badge.replaceWith(StepsembleAgentIdentity.create(doc, row.agentId, true));
                copy.children[0].textContent = deps.title(row);
                copy.children[0].dataset.i18nIgnore = "";
                copy.children[1].textContent = `${StepsembleAgentIdentity.lookup(row.agentId).label} · ${t(row.kind)} · ${deps.status(row)}`;
                copy.children[2].textContent = [row.project, deps.updated(row)].filter(Boolean).join(" · ");
                copy.children[2].dataset.i18nIgnore = "";
                const position = result.entries.indexOf(row);
                if (list.children[position] !== item)
                    list.insertBefore(item, list.children[position] ?? null);
            }
            for (const item of existing.values())
                item.remove();
            if (!result.entries.length)
                list.append(el("p", t("empty"), "conversation-empty"));
        }
        function filters() {
            const selected = agent.value;
            agent.replaceChildren();
            for (const id of ["all", ...new Set(snapshot.entries.map(row => row.agentId))]) {
                const option = el("option", id === "all" ? t("allAgents") : StepsembleAgentIdentity.lookup(id).label);
                option.value = id;
                agent.append(option);
            }
            if ([...agent.options].some(option => option.value === selected))
                agent.value = selected;
            const selectedKind = kind.value;
            kind.replaceChildren();
            for (const id of ["all", "active", "pi_history", "task_record"]) {
                const option = el("option", t(id));
                option.value = id;
                kind.append(option);
            }
            if (selectedKind)
                kind.value = selectedKind;
        }
        for (const control of [search, agent, kind])
            control.addEventListener(control === search ? "input" : "change", () => { page = 0; list.scrollTop = 0; render(); });
        previous.addEventListener("click", () => { page--; list.scrollTop = 0; render(); });
        next.addEventListener("click", () => { page++; list.scrollTop = 0; render(); });
        refresh.addEventListener("click", async () => {
            if (busy)
                return;
            const ticket = epoch;
            busy = true;
            render();
            try {
                await deps.refresh();
            }
            catch {
                if (epoch === ticket)
                    stale = true;
            }
            finally {
                if (epoch === ticket && dialog.open) {
                    busy = false;
                    render();
                }
            }
        });
        // Search inputs otherwise consume Escape just to clear their value. Close
        // consistently in one press, but never interrupt an IME composition.
        function onKeydown(event) {
            event.stopPropagation();
            if (event.key === "Escape" && !event.isComposing) {
                event.preventDefault();
                dialog.close();
            }
        }
        dialog.addEventListener("keydown", onKeydown);
        dialog.addEventListener("close", () => { epoch++; busy = false; });
        function reset() {
            epoch++;
            busy = false;
            snapshot = { entries: [], omitted: 0 };
            visible.clear();
            hostId = "";
            hostLabel = "";
            page = 0;
            stale = false;
            search.value = "";
            agent.replaceChildren();
            kind.replaceChildren();
            list.replaceChildren();
            if (dialog.open)
                dialog.close();
        }
        function update(next, id, label, sourceStale) {
            if (hostId && hostId !== id)
                reset();
            snapshot = next;
            hostId = id;
            hostLabel = label;
            stale = sourceStale;
            filters();
            render();
        }
        return Object.freeze({ update, reset, open() { if (!dialog.open) {
                dialog.showModal();
                search.focus();
            } }, isOpen: () => dialog.open });
    }
    StepsembleConversations.createView = createView;
})(StepsembleConversations || (StepsembleConversations = {}));
if (typeof module !== "undefined")
    module.exports = StepsembleConversations;
