"use strict";
/// <reference path="./history-i18n.ts" />
/// <reference path="./history-transport.ts" />
/// <reference path="./claude-history.ts" />
/// <reference path="./projection.ts" />
/// <reference path="./history-sources.ts" />
/// <reference path="./agent-identity.ts" />
/// <reference path="./codex-history-view.ts" />
/** Isolated inert-history preview. Only trusted catalog IDs reach the transport;
 * native text never becomes HTML, a URL, an executable action or authority. */
var StepsembleHistoryView;
(function (StepsembleHistoryView) {
    const i18n = typeof module !== "undefined" ? require("./history-i18n") : StepsembleHistoryI18n;
    StepsembleHistoryView.LIMITS = Object.freeze({ messages: 10, blocks: 24, textUnits: 48000, blockTextUnits: 8000, evidence: 20 });
    const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    const same = (a, b) => !!a && a.bindingId === b.bindingId && a.generation === b.generation && a.sessionId === b.sessionId;
    const uuid = (v) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
    function describeError(code) { return i18n.text(i18n.errorKey(code)); }
    StepsembleHistoryView.describeError = describeError;
    function createModel(deps) {
        if (!deps || !uuid(deps.viewId) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(deps.hostId) || typeof deps.createPages !== "function"
            || !deps.transport || ![deps.transport.register, deps.transport.read, deps.transport.release].every(v => typeof v === "function"))
            throw new Error("history_view_dependencies_required");
        const catalog = structuredClone(deps.catalog);
        if (!Array.isArray(catalog) || catalog.length > 256 || catalog.some(e => !object(e) || Object.keys(e).sort().join(",") !== "catalogId,description,label"
            || typeof e.catalogId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(e.catalogId) || typeof e.label !== "string" || !e.label.length || e.label.length > 120 || /[\u0000-\u001f\u007f]/.test(e.label)
            || typeof e.description !== "string" || e.description.length > 300 || /[\u0000-\u001f\u007f]/.test(e.description)) || new Set(catalog.map(e => e.catalogId)).size !== catalog.length)
            throw new Error("history_catalog_invalid");
        const now = deps.now ?? Date.now;
        let selected = null, binding = null, controller = deps.createPages(deps.transport.read);
        let snapshot = controller.state(), pending = null, candidate = null;
        let epoch = 0, busy = false, stage = "choose", error = null, stale = false, closed = false;
        let limit = 10, offset = null, messageStart = 0, cleanupPending = false;
        const notify = () => deps.onChange?.();
        function cancelWork() {
            epoch++;
            pending?.abort();
            pending = null;
            controller.cancel();
            candidate?.cancel();
            if (candidate && candidate !== controller)
                candidate.dispose();
            candidate = null;
            busy = false;
        }
        async function release(row) {
            if (!row)
                return;
            try {
                const result = await deps.transport.release({ bindingId: row.bindingId, generation: row.generation });
                if (result.kind !== "history_released" || !result.cleanupConfirmed)
                    cleanupPending = true;
            }
            catch {
                cleanupPending = true;
            }
        }
        function state() {
            const found = snapshot.pages.findIndex(p => p.offset === offset), index = Math.max(0, found), page = snapshot.pages[index] ?? null;
            const expired = !!binding && now() >= binding.expiresAt;
            const isStale = stale || snapshot.status === "stale" || expired;
            return structuredClone({ selected, busy, stage, error, stale: isStale, closed, limit, pageIndex: index, pageCount: snapshot.pages.length,
                messageStart, retainedMessages: snapshot.messageCount, cleanupPending, sourceVersion: snapshot.sourceVersion, page,
                canPrevious: !busy && !!page && (index > 0 || !isStale && page.offset > 0),
                canNext: !busy && !!page && (index < snapshot.pages.length - 1 || !isStale && !snapshot.reachedEnd) });
        }
        function showWindow(start) {
            const page = state().page;
            if (page && Number.isSafeInteger(start) && start >= 0 && start < page.observation.messages.length) {
                messageStart = start;
                notify();
            }
        }
        function setLimit(value) { if ([5, 10, 25].includes(value)) {
            limit = value;
            notify();
        } }
        async function load(mode, selectionEpoch) {
            if (!selected || closed)
                return;
            if (mode !== "refresh" && busy)
                return;
            if (selectionEpoch === undefined)
                cancelWork();
            const ticket = epoch, item = selected, abort = new AbortController();
            pending = abort;
            busy = true;
            error = null;
            stage = "preparing";
            notify();
            let target = controller;
            try {
                // Renew only as part of an explicit read. No polling, keepalive timer or
                // automatic retry. An expired lease may produce a different generation.
                const reg = await deps.transport.register({ catalogId: item.catalogId, viewId: deps.viewId }, abort.signal);
                if (ticket !== epoch || abort.signal.aborted) {
                    if (reg.kind === "history_registration" && selected?.catalogId !== reg.catalogId && !same(binding, reg))
                        await release(reg);
                    return;
                }
                if (reg.kind !== "history_registration") {
                    error = reg.code;
                    stale = snapshot.pages.length > 0;
                    return;
                }
                const changed = !same(binding, reg);
                binding = reg;
                if (changed && mode !== "refresh") {
                    stale = true;
                    error = "history_binding_unavailable";
                    return;
                }
                if (changed || !snapshot.scope || snapshot.scope.bindingId !== reg.bindingId || snapshot.scope.generation !== reg.generation) {
                    target = deps.createPages(deps.transport.read);
                    candidate = target;
                    target.reset({ hostId: deps.hostId, bindingId: reg.bindingId, generation: reg.generation, sessionId: reg.sessionId });
                }
                const requestedOffset = mode === "refresh" ? offset ?? 0 : mode === "previous" ? Math.max(0, (snapshot.startOffset ?? 0) - limit) : snapshot.nextOffset;
                stage = "reading";
                const flight = mode === "refresh" ? target.refresh({ offset: requestedOffset ?? 0, limit })
                    : mode === "next" ? target.loadNext(limit) : target.loadPrevious(limit);
                notify();
                const result = await flight;
                if (ticket !== epoch || abort.signal.aborted)
                    return;
                if (result.kind === "applied") {
                    if (target !== controller) {
                        controller.dispose();
                        controller = target;
                        candidate = null;
                    }
                    snapshot = controller.state();
                    if (snapshot.pages.some(page => page.offset === requestedOffset))
                        offset = requestedOffset;
                    messageStart = 0;
                    stale = false;
                    error = null;
                    stage = "loaded";
                }
                else if (result.kind === "unavailable") {
                    error = result.code;
                    stale = snapshot.pages.length > 0;
                    if (target === controller)
                        snapshot = controller.state();
                }
            }
            catch (reason) {
                if (ticket !== epoch || abort.signal.aborted)
                    return;
                error = object(reason) && typeof reason.code === "string" && Object.hasOwn(i18n.errors, reason.code) ? reason.code : "history_transport_failed";
                stale = snapshot.pages.length > 0;
            }
            finally {
                if (target !== controller)
                    target.dispose();
                if (ticket === epoch) {
                    candidate = null;
                    pending = null;
                    busy = false;
                    if (error)
                        stage = "failed";
                    notify();
                }
            }
        }
        async function select(catalogId) {
            const item = catalog.find(entry => entry.catalogId === catalogId);
            if (!item)
                return;
            if (selected?.catalogId === catalogId && !closed)
                return;
            cancelWork();
            const ticket = epoch, old = binding;
            binding = null;
            selected = item;
            closed = false;
            error = null;
            stale = false;
            controller.dispose();
            controller = deps.createPages(deps.transport.read);
            snapshot = controller.state();
            offset = null;
            messageStart = 0;
            busy = true;
            stage = old ? "switching" : "preparing";
            notify();
            await release(old);
            if (ticket !== epoch)
                return;
            await load("refresh", ticket);
        }
        async function navigate(direction) {
            const current = state();
            if (busy || !current.page)
                return;
            const next = current.pageIndex + (direction === "next" ? 1 : -1), cached = snapshot.pages[next];
            if (cached) {
                offset = cached.offset;
                messageStart = 0;
                notify();
                return;
            }
            if (current.stale) {
                stale = true;
                error = "history_refresh_required";
                notify();
                return;
            }
            if (direction === "next" ? current.canNext : current.canPrevious)
                await load(direction);
        }
        function cancel() { cancelWork(); stage = "cancelled"; notify(); }
        async function close() {
            cancelWork();
            const old = binding;
            binding = null;
            selected = null;
            closed = true;
            error = null;
            stale = false;
            controller.dispose();
            controller = deps.createPages(deps.transport.read);
            snapshot = controller.state();
            offset = null;
            messageStart = 0;
            stage = "closed";
            notify();
            await release(old);
            notify();
        }
        return Object.freeze({ select, refresh: () => load("refresh"), next: () => navigate("next"), previous: () => navigate("previous"), cancel, close, setLimit, showWindow, state });
    }
    StepsembleHistoryView.createModel = createModel;
    function create(deps) {
        const doc = deps.root.ownerDocument;
        const element = (tag, value = "", className = "") => {
            const node = doc.createElement(tag);
            i18n.raw(node, value);
            if (className)
                node.className = className;
            return node;
        };
        const copy = (tag, key, className = "", vars = {}) => i18n.bind(element(tag, "", className), key, vars);
        const tabs = element("nav", "", "history-sources");
        i18n.bind(tabs, "choose", {}, "aria-label");
        const title = copy("h2", "choose"), description = element("p", "", "history-description");
        const status = element("p", "", "history-status");
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        const warning = element("p", "", "history-warning");
        warning.setAttribute("role", "status");
        const warningReason = element("span"), prior = copy("span", "priorPage");
        warning.append(warningReason, doc.createTextNode ? doc.createTextNode(" ") : element("span", " "), prior);
        const toolbar = element("div", "", "history-toolbar"), controls = {};
        const button = (actionId, key, action, parent = toolbar, vars = {}) => {
            const node = copy("button", key, "", vars);
            node.type = "button";
            node.dataset.action = actionId;
            node.addEventListener("click", () => { void action(); });
            parent.append(node);
            controls[actionId] = node;
            return node;
        };
        const model = createModel({ ...deps, onChange: () => { render(); deps.onChange?.(); } });
        const tabButtons = deps.catalog.map(entry => {
            // Catalog labels are owner-authored, even when they equal an interface key.
            const node = element("button", entry.label);
            node.type = "button";
            node.dataset.action = "source:" + entry.catalogId;
            node.addEventListener("click", () => { void model.select(entry.catalogId); });
            tabs.append(node);
            node.setAttribute("aria-pressed", "false");
            return node;
        });
        button("refresh", "refresh", () => model.refresh());
        button("previous", "previous", () => model.previous());
        button("next", "next", () => model.next());
        button("cancel", "cancel", () => model.cancel());
        button("close", "close", () => model.close());
        const label = element("label", "", "history-limit"), select = element("select");
        i18n.bind(select, "limit", {}, "aria-label");
        label.append(copy("span", "limit"));
        for (const n of [5, 10, 25]) {
            const option = element("option", String(n));
            option.value = String(n);
            select.append(option);
        }
        select.value = "10";
        select.addEventListener("change", () => model.setLimit(Number(select.value)));
        label.append(select);
        toolbar.append(label);
        const content = element("section", "", "history-messages");
        i18n.bind(content, "messages", {}, "aria-label");
        const position = element("p", "", "history-position"), windowBar = element("div", "", "history-window-controls");
        button("windowPrevious", "windowPrevious", () => model.showWindow(Math.max(0, model.state().messageStart - StepsembleHistoryView.LIMITS.messages)), windowBar, { count: StepsembleHistoryView.LIMITS.messages });
        button("windowNext", "windowNext", () => model.showWindow(model.state().messageStart + StepsembleHistoryView.LIMITS.messages), windowBar, { count: StepsembleHistoryView.LIMITS.messages });
        const evidence = element("section", "", "history-evidence"), cleanup = element("p", "", "history-footnote");
        deps.root.dataset.i18nIgnore = "";
        deps.root.replaceChildren(tabs, title, description, toolbar, status, warning, position, content, windowBar, evidence, cleanup);
        if (deps.embedded) {
            tabs.hidden = true;
            title.hidden = true;
            description.hidden = true;
        }
        let renderedPage = null, renderedWindow = -1;
        function render() {
            const s = model.state();
            deps.root.setAttribute("aria-busy", String(s.busy));
            if (s.selected) {
                i18n.raw(title, s.selected.label);
                i18n.raw(description, s.selected.description);
            }
            else {
                i18n.bind(title, s.closed ? "closed" : "choose");
                i18n.bind(description, "historyInfo");
            }
            i18n.bind(status, s.stage);
            warning.hidden = !s.error && !s.stale;
            i18n.bind(warningReason, s.error ? i18n.errorKey(s.error) : "pageStale");
            prior.hidden = !s.error || !s.page;
            warning.dataset.state = s.stale ? "stale" : "error";
            tabButtons.forEach((node, index) => node.setAttribute("aria-pressed", String(deps.catalog[index].catalogId === s.selected?.catalogId)));
            controls.refresh.disabled = !s.selected;
            controls.previous.disabled = !s.canPrevious;
            controls.next.disabled = !s.canNext;
            controls.cancel.disabled = !s.busy;
            controls.close.disabled = !s.selected && !s.busy;
            controls.windowPrevious.disabled = s.messageStart === 0;
            controls.windowNext.disabled = !s.page || s.messageStart + StepsembleHistoryView.LIMITS.messages >= s.page.observation.messages.length;
            select.value = String(s.limit);
            i18n.bind(cleanup, s.cleanupPending ? "cleanupPending" : "cleanupSafe");
            const pageKey = s.page ? JSON.stringify([s.sourceVersion, s.page.offset, s.page.limit, s.page.observation.selectionDigest]) : null;
            if (s.page)
                i18n.bind(position, "position", { retained: s.retainedMessages, page: s.pageIndex + 1, pages: s.pageCount,
                    start: s.page.observation.messages.length ? s.messageStart + 1 : 0, end: Math.min(s.messageStart + StepsembleHistoryView.LIMITS.messages, s.page.observation.messages.length),
                    total: s.page.observation.messages.length, offset: s.page.offset });
            else
                i18n.bind(position, "notRead");
            windowBar.hidden = !s.page || s.page.observation.messages.length <= StepsembleHistoryView.LIMITS.messages;
            if (pageKey === renderedPage && s.messageStart === renderedWindow)
                return;
            renderedPage = pageKey;
            renderedWindow = s.messageStart;
            content.replaceChildren();
            evidence.replaceChildren();
            if (!s.page) {
                content.append(copy("p", s.closed ? "reopen" : "empty", "history-empty"));
                return;
            }
            let remaining = StepsembleHistoryView.LIMITS.textUnits, truncated = false, exhausted = false;
            const clipped = (input, maximum = StepsembleHistoryView.LIMITS.blockTextUnits) => {
                const count = Math.min(remaining, maximum);
                if (count <= 0) {
                    exhausted = true;
                    return "";
                }
                const value = input.slice(0, count);
                remaining -= value.length;
                if (input.length > value.length)
                    truncated = true;
                return value; // Display notices stay separate from the native text.
            };
            const details = (heading, value, parent, vars = {}) => {
                const node = element("details"), summary = copy("summary", heading, "", vars), pre = element("pre", "", "history-inert-data");
                const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
                i18n.raw(pre, clipped(text ?? ""));
                node.append(summary, pre);
                parent.append(node);
            };
            const pageMessages = s.page.observation.messages.slice(s.messageStart, s.messageStart + StepsembleHistoryView.LIMITS.messages);
            if (!pageMessages.length)
                content.append(copy("p", "pageEmpty", "history-empty"));
            for (const message of pageMessages) {
                const card = element("article", "", "history-message");
                card.append(message.role === "assistant" ? element("h3", "Claude") : copy("h3", message.role === "user" ? "you" : "system"), typeof message.originalTimestamp === "string" ? element("p", clipped(message.originalTimestamp, 120), "history-message-time") : copy("p", "noTime", "history-message-time"));
                const blocks = Array.isArray(message.blocks) ? message.blocks : [];
                for (const block of blocks.slice(0, StepsembleHistoryView.LIMITS.blocks)) {
                    if (!object(block))
                        continue;
                    if (block.kind === "text" && typeof block.text === "string")
                        card.append(element("p", clipped(block.text), "history-message-text"));
                    else if (block.kind === "thinking")
                        details("thinking", block.text, card);
                    else if (block.kind === "tool_use")
                        details("toolUse", block, card);
                    else if (block.kind === "tool_result")
                        details("toolResult", block, card);
                    else if (block.kind === "attachment")
                        details("attachment", block, card);
                    else
                        details("other", block, card);
                }
                if (blocks.length > StepsembleHistoryView.LIMITS.blocks)
                    card.append(copy("p", "blockLimit", "history-footnote", { count: StepsembleHistoryView.LIMITS.blocks }));
                content.append(card);
            }
            for (const [key, heading] of [["tools", "tools"], ["auxiliaryRecords", "auxiliary"], ["warnings", "warnings"]]) {
                const rows = s.page.observation[key];
                if (Array.isArray(rows) && rows.length)
                    details(heading, rows.slice(0, StepsembleHistoryView.LIMITS.evidence), evidence, { count: rows.length, limit: StepsembleHistoryView.LIMITS.evidence });
            }
            if (truncated)
                evidence.append(copy("p", "truncated", "history-footnote"));
            if (exhausted)
                evidence.append(copy("p", "textLimit", "history-footnote"));
        }
        render();
        return Object.freeze({ ...model, render });
    }
    StepsembleHistoryView.create = create;
    function hostRoute(search) {
        const params = new URLSearchParams(search), entries = [...params];
        if (!entries.length)
            return { hostId: "local", routePrefix: "" };
        if (entries.length !== 1 || entries[0][0] !== "machine" || !/^[a-z0-9-]{1,48}$/.test(entries[0][1]))
            throw new Error("history_route_invalid");
        return { hostId: entries[0][1], routePrefix: `/r/${entries[0][1]}` };
    }
    StepsembleHistoryView.hostRoute = hostRoute;
    async function bootHost() {
        const root = document.querySelector("[data-history-host]");
        if (!root)
            return;
        i18n.boot();
        const status = document.createElement("p");
        status.className = "history-empty";
        status.setAttribute("role", "status");
        i18n.bind(status, "confirming");
        root.replaceChildren(status);
        const abort = new AbortController();
        let gone = false;
        const views = [];
        const close = () => { gone = true; abort.abort(); for (const view of views)
            void view.close(); };
        window.addEventListener("pagehide", close, { once: true });
        // A bfcache-restored document must not revive an old credential/view scope.
        window.addEventListener("pageshow", event => { if (event.persisted)
            location.reload(); });
        const showUnavailable = (key) => {
            if (gone)
                return;
            i18n.bind(status, key);
            const retry = document.createElement("button");
            retry.className = "history-button";
            retry.type = "button";
            i18n.bind(retry, "recheck");
            retry.addEventListener("click", () => location.reload());
            root.replaceChildren(status, retry);
        };
        try {
            const route = hostRoute(location.search), viewId = crypto.randomUUID(), canonicalJSON = StepsembleProjection.canonicalJSON;
            const label = document.querySelector("[data-history-host-label]");
            if (label) {
                const name = i18n.bind(document.createElement("span"), route.hostId === "local" ? "localHost" : "remoteHost");
                const id = i18n.raw(document.createElement("span"), route.hostId === "local" ? "" : ` · ${route.hostId}`);
                label.replaceChildren(name, id);
            }
            const transport = StepsembleHistoryTransport.create({ ...route, origin: location.origin, viewId, canonicalJSON });
            const [result, groups] = await Promise.all([transport.catalog(abort.signal), transport.sources(abort.signal)]);
            if (gone)
                return;
            if (result.kind !== "history_catalog") {
                showUnavailable(i18n.errorKey(result.code));
                return;
            }
            if (groups.kind === "source_unavailable" && !["history_method_not_allowed", "history_source_unavailable"].includes(groups.code)) {
                showUnavailable(i18n.errorKey(groups.code));
                return;
            }
            const sources = groups.kind === "history_sources" ? groups.sources : [];
            if (!result.entries.length && !sources.length) {
                showUnavailable("noSources");
                return;
            }
            const provider = StepsembleClaudeHistory.create({ canonicalJSON });
            const createPages = (read) => StepsembleHistoryPages.create({ read, canonicalJSON, validateHistory: provider.validateHistory, requestId: () => crypto.randomUUID() });
            root.replaceChildren();
            if (sources.length) {
                const browser = document.createElement("div");
                root.append(browser);
                views.push(StepsembleHistorySources.create({ root: browser, groups: sources, transport, protocol: StepsembleHistoryTransport, requestId: () => crypto.randomUUID(),
                    describeError, badge: (doc, agentId) => StepsembleAgentIdentity.create(doc, agentId),
                    createContent(contentRoot, catalogId, agentId) {
                        const contentViewId = crypto.randomUUID(), contentTransport = StepsembleHistoryTransport.create({ ...route, origin: location.origin, viewId: contentViewId, canonicalJSON });
                        if (agentId === "codex")
                            return StepsembleCodexHistoryView.create({ root: contentRoot, ...route, viewId: contentViewId, catalogId, transport: contentTransport,
                                canonicalJSON, requestId: () => crypto.randomUUID() });
                        return create({ root: contentRoot, ...route, viewId: contentViewId, catalog: [{ catalogId, label: i18n.text("content"), description: "" }],
                            transport: contentTransport, createPages, embedded: true });
                    } }));
            }
            if (result.entries.length) {
                const manualRoot = document.createElement("div");
                const init = () => { if (gone || manualRoot.childNodes.length)
                    return; views.push(create({ root: manualRoot, ...route, viewId, catalog: result.entries, transport, createPages })); };
                if (sources.length) {
                    const details = document.createElement("details"), summary = document.createElement("summary");
                    i18n.bind(summary, "manual", { count: result.entries.length });
                    details.className = "history-manual";
                    details.append(summary, manualRoot);
                    root.append(details);
                    details.addEventListener("toggle", () => { if (details.open)
                        init(); });
                }
                else {
                    root.append(manualRoot);
                    init();
                }
            }
        }
        catch (error) {
            showUnavailable(error instanceof StepsembleHistoryTransport.TransportError ? i18n.errorKey(error.code) : "bootFailed");
        }
    }
    StepsembleHistoryView.bootHost = bootHost;
    /** Only the isolated preview document calls this. It has no production import
     * or service-worker registration and accepts no URL-supplied source options. */
    async function bootPreview() {
        const root = document.querySelector("[data-history-preview]");
        if (!root)
            return;
        i18n.boot();
        const status = document.createElement("p");
        i18n.bind(status, "previewLoading");
        root.replaceChildren(status);
        try {
            const viewId = crypto.randomUUID(), canonicalJSON = StepsembleProjection.canonicalJSON;
            const transport = StepsembleHistoryTransport.create({ origin: location.origin, hostId: "history-preview", viewId, canonicalJSON });
            const result = await transport.catalog();
            if (result.kind !== "history_catalog") {
                i18n.bind(status, i18n.errorKey(result.code));
                return;
            }
            const provider = StepsembleClaudeHistory.create({ canonicalJSON });
            const view = create({ root, hostId: "history-preview", viewId, catalog: result.entries, transport,
                createPages: read => StepsembleHistoryPages.create({ read, canonicalJSON, validateHistory: provider.validateHistory, requestId: () => crypto.randomUUID() }) });
            window.addEventListener("pagehide", () => { void view.close(); }, { once: true });
        }
        catch {
            i18n.bind(status, "previewFailed");
        }
    }
    StepsembleHistoryView.bootPreview = bootPreview;
})(StepsembleHistoryView || (StepsembleHistoryView = {}));
if (typeof module !== "undefined")
    module.exports = StepsembleHistoryView;
else if (typeof document !== "undefined")
    document.addEventListener("DOMContentLoaded", () => {
        void StepsembleHistoryView.bootPreview();
        void StepsembleHistoryView.bootHost();
    }, { once: true });
