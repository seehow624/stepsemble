"use strict";
/// <reference path="./history-transport.ts" />
/** Bounded source-group browser. Inventory is explicit; only visible row names
 * are read, one at a time. No model calls, transcript prefetch or private paths. */
var StepsembleHistorySources;
(function (StepsembleHistorySources) {
    function createModel(deps) {
        const groups = structuredClone(deps.groups);
        if (!deps.protocol.validSources({ kind: "history_sources", sources: groups, sourceAuthenticated: false, publishable: false })
            || !groups.length || typeof deps.requestId !== "function" || !deps.transport)
            throw new Error("history_sources_dependencies_required");
        let group = groups[0], page = null, rows = [], selected = null;
        let busy = false, closed = false, error = null, epoch = 0, namesPaused = false;
        let pending = null, nameFlight = null;
        let visible = new Set();
        const notify = () => deps.onChange?.();
        const problem = (e) => e instanceof deps.protocol.TransportError ? e.code : "history_transport_failed";
        const revoked = (code) => ["history_unauthorized", "history_principal_unavailable", "history_source_unavailable"].includes(code);
        function stopNames() {
            const old = nameFlight;
            nameFlight = null;
            old?.controller.abort();
            if (old?.row.status === "loading")
                old.row.status = "not_loaded";
        }
        function invalidate() { epoch++; pending?.abort(); pending = null; stopNames(); visible.clear(); busy = false; }
        function fail(code) {
            error = code;
            if (page)
                page.stale = true;
            if (revoked(code)) {
                rows = [];
                page = null;
                selected = null;
                stopNames();
            }
        }
        function state() { return structuredClone({ group, page, rows, selected, busy, namesBusy: nameFlight !== null, namesPaused, error, closed }); }
        async function load(offset = 0, refresh = false) {
            if (closed)
                return;
            invalidate();
            const ticket = epoch, controller = new AbortController();
            pending = controller;
            busy = true;
            error = null;
            notify();
            const request = { sourceId: group.sourceId, page: { offset, limit: 50 }, snapshotId: refresh ? null : page?.snapshotId ?? null, refresh };
            try {
                const result = await deps.transport.sourceCatalog(request, controller.signal);
                if (closed || ticket !== epoch || controller.signal.aborted)
                    return;
                if (result.kind === "source_unavailable") {
                    fail(result.code);
                    return;
                }
                if (!deps.protocol.validSourceCatalog(result, request)) {
                    fail("history_response_invalid");
                    return;
                }
                page = structuredClone(result);
                rows = page.entries.map(e => ({ catalogId: e.catalogId, metadata: null, status: "not_loaded", error: null }));
                if (page.lastError)
                    error = page.lastError;
            }
            catch (e) {
                if (!closed && ticket === epoch && !controller.signal.aborted)
                    fail(problem(e));
            }
            finally {
                if (ticket === epoch && !closed) {
                    pending = null;
                    busy = false;
                    notify();
                }
            }
        }
        async function pump() {
            if (closed || busy || namesPaused || nameFlight || !page?.snapshotId || page.stale)
                return;
            const row = rows.find(r => r.status === "not_loaded" && visible.has(r.catalogId));
            if (!row)
                return;
            const request = { sourceId: group.sourceId, catalogId: row.catalogId, snapshotId: page.snapshotId, requestId: deps.requestId() };
            const flight = { controller: new AbortController(), row, epoch };
            nameFlight = flight;
            row.status = "loading";
            row.error = null;
            notify();
            const current = () => !closed && nameFlight === flight && epoch === flight.epoch && !flight.controller.signal.aborted;
            try {
                const result = await deps.transport.sourceMetadata(request, flight.controller.signal);
                if (!current())
                    return;
                if (result.kind === "source_unavailable")
                    throw new deps.protocol.TransportError(result.code);
                if (!deps.protocol.validSourceMetadata(result, request))
                    throw new deps.protocol.TransportError("history_response_invalid");
                row.metadata = structuredClone(result.metadata);
                row.status = "loaded";
                if (selected?.sourceId === request.sourceId && selected.snapshotId === request.snapshotId && selected.catalogId === row.catalogId)
                    selected = { ...structuredClone(row), sourceId: request.sourceId, snapshotId: request.snapshotId };
            }
            catch (e) {
                if (!current())
                    return;
                row.error = problem(e);
                row.status = "error";
                if (revoked(row.error) || row.error === "history_catalog_changed") {
                    fail(row.error);
                    notify();
                }
            }
            finally {
                if (current()) {
                    nameFlight = null;
                    notify();
                    void pump();
                }
            }
        }
        function setVisible(ids) {
            visible = new Set(ids.slice(0, 50).filter(id => rows.some(r => r.catalogId === id)));
            // Scrolling away cancels this UI's name read; it never cancels content.
            if (nameFlight && !visible.has(nameFlight.row.catalogId)) {
                stopNames();
                notify();
            }
            void pump();
        }
        async function selectGroup(sourceId) {
            const found = groups.find(g => g.sourceId === sourceId);
            if (!found || closed)
                return;
            invalidate();
            group = found;
            page = null;
            rows = [];
            selected = null;
            error = null;
            notify();
            await load();
        }
        function select(catalogId) {
            const row = rows.find(r => r.catalogId === catalogId);
            if (closed || busy || page?.stale || !row || !page?.snapshotId)
                return;
            selected = { ...structuredClone(row), sourceId: group.sourceId, snapshotId: page.snapshotId };
            notify();
        }
        function pauseNames() { namesPaused = true; stopNames(); notify(); }
        function resumeNames() {
            if (closed)
                return;
            namesPaused = false;
            for (const row of rows)
                if (visible.has(row.catalogId) && row.status === "error") {
                    row.status = "not_loaded";
                    row.error = null;
                }
            notify();
            void pump();
        }
        function retryName(id) {
            const row = rows.find(r => r.catalogId === id);
            if (!row || closed || busy || page?.stale || !["not_loaded", "error"].includes(row.status))
                return;
            row.status = "not_loaded";
            row.error = null;
            namesPaused = false;
            visible.add(id);
            void pump();
        }
        function cancel() { invalidate(); if (page)
            page.stale = true; error = null; namesPaused = true; notify(); }
        function close() { invalidate(); closed = true; rows = []; selected = null; page = null; notify(); }
        return Object.freeze({ state, start: () => load(), selectGroup, select, setVisible, pauseNames, resumeNames, retryName, cancel, close,
            refresh: () => load(0, true), previous: () => !busy && page && !page.stale && page.page.offset > 0 ? load(Math.max(0, page.page.offset - 50)) : Promise.resolve(),
            next: () => !busy && page && !page.stale && page.nextOffset !== null ? load(page.nextOffset) : Promise.resolve() });
    }
    StepsembleHistorySources.createModel = createModel;
    function create(deps) {
        const doc = deps.root.ownerDocument;
        const el = (tag, text = "", className = "") => {
            const node = doc.createElement(tag);
            node.textContent = text;
            node.className = className;
            return node;
        };
        const panel = el("section", "", "source-browser"), heading = el("h2", "原生對話"), label = el("label", "來源 "), select = el("select");
        select.setAttribute("aria-label", "原生對話來源");
        for (const group of deps.groups) {
            const option = el("option", group.label);
            option.value = group.sourceId;
            select.append(option);
        }
        label.append(select);
        const description = el("p", "", "history-description"), toolbar = el("div", "", "source-toolbar");
        const button = (text, action, parent = toolbar) => {
            const node = el("button", text);
            node.type = "button";
            node.addEventListener("click", () => { void action(); });
            parent.append(node);
            return node;
        };
        const status = el("p", "", "history-status");
        status.setAttribute("role", "status");
        const warning = el("p", "", "history-warning");
        warning.setAttribute("role", "status");
        const list = el("div", "", "source-list");
        list.setAttribute("role", "list");
        list.setAttribute("aria-label", "原生對話清單");
        list.tabIndex = 0;
        const empty = el("p", "", "history-empty"), pager = el("nav", "", "source-pager");
        pager.setAttribute("aria-label", "對話清單分頁");
        const names = el("p", "只按需載入可見列名稱；摘要不是對話標題。", "history-footnote");
        const detail = el("section", "", "source-detail"), selectedTitle = el("h2"), selectedSummary = el("p", "", "history-description"), selectedWarning = el("p", "", "history-warning");
        const summaryDetails = el("details", "", "source-summary-detail");
        summaryDetails.append(el("summary", "原生摘要"), selectedSummary);
        let titleExpanded = false;
        const titleToggle = button("展開完整名稱", () => { titleExpanded = !titleExpanded; render(); }, detail);
        selectedTitle.tabIndex = -1;
        const contentRoot = el("div");
        detail.replaceChildren(selectedTitle, titleToggle, summaryDetails, selectedWarning, contentRoot);
        detail.hidden = true;
        let content = null, selectionKey = null, closing = null, listKey = "", observer = null;
        const nodes = new Map();
        const model = createModel({ ...deps, onChange: () => { render(); deps.onChange?.(); } });
        const refresh = button("重新整理來源", () => model.refresh()), cancel = button("取消載入", () => model.cancel());
        const pause = button("暫停載入名稱", () => model.pauseNames()), resume = button("繼續／重試名稱", () => model.resumeNames());
        const previous = button("上一頁對話", () => model.previous(), pager), position = el("span", "", "history-position");
        pager.append(position);
        const next = button("下一頁對話", () => model.next(), pager);
        select.addEventListener("change", () => { void model.selectGroup(select.value); });
        panel.append(heading, label, description, toolbar, status, warning, list, empty, pager, names);
        deps.root.replaceChildren(panel, detail);
        function title(row) {
            return row.metadata ? row.metadata.nativeTitle ?? "未命名對話" : row.status === "loading" ? "正在讀取名稱…" : row.status === "error" ? "名稱暫時不可用" : "名稱尚未載入";
        }
        function observeRows(key) {
            observer?.disconnect();
            observer = null;
            const visible = new Set();
            if (model.state().closed || !nodes.size)
                return;
            if (typeof IntersectionObserver === "undefined") {
                model.setVisible([]);
                return;
            } // Row button remains an explicit fallback.
            observer = new IntersectionObserver(entries => {
                if (key !== listKey)
                    return;
                for (const entry of entries) {
                    const id = entry.target.dataset.catalogId;
                    if (entry.isIntersecting)
                        visible.add(id);
                    else
                        visible.delete(id);
                }
                model.setVisible([...visible]);
            }, { root: list, threshold: 0.01 });
            for (const node of nodes.values())
                observer.observe(node.row);
        }
        function startContent() {
            if (closing || content)
                return;
            const selected = model.state().selected;
            if (!selected)
                return;
            try {
                const current = deps.createContent(contentRoot, selected.catalogId);
                content = current;
                void current.select(selected.catalogId).catch(() => { if (content === current)
                    contentRoot.textContent = "無法載入內容，請重新選取對話。"; });
            }
            catch {
                contentRoot.textContent = "無法開啟內容，請重新選取對話。";
            }
        }
        function render() {
            const s = model.state();
            select.value = s.group.sourceId;
            description.textContent = s.group.description;
            refresh.disabled = s.busy || s.closed;
            cancel.hidden = !s.busy;
            pause.hidden = s.namesPaused || !s.rows.length;
            resume.hidden = !s.namesPaused && !s.rows.some(r => r.status === "error");
            resume.disabled = s.busy || s.page?.stale === true;
            panel.setAttribute("aria-busy", String(s.busy));
            warning.hidden = !s.error && !(s.page?.snapshotId && s.page.stale);
            warning.textContent = s.error ? deps.describeError(s.error) : "清單已過期。保留上次結果，請重新整理來源後再開啟或翻頁。";
            status.textContent = s.busy ? "正在載入來源清單…" : s.page?.snapshotId ? `找到 ${s.page.total} 個主對話。點選一列開啟唯讀歷史。` : "尚未掃描此來源。按「重新整理來源」讀取已授權的主對話清單。";
            empty.hidden = s.rows.length > 0;
            list.hidden = !s.rows.length;
            empty.textContent = s.page?.snapshotId ? "這次清單沒有符合範圍的主對話。" : "只探索已授權的來源，不會自動掃描私人目錄。";
            previous.disabled = s.busy || !s.page || s.page.stale || s.page.page.offset === 0;
            next.disabled = s.busy || !s.page || s.page.stale || s.page.nextOffset === null;
            position.textContent = s.rows.length && s.page ? `${s.page.page.offset + 1}–${s.page.page.offset + s.rows.length} / ${s.page.total}` : "0 / 0";
            const key = JSON.stringify([s.group.sourceId, s.page?.snapshotId, s.page?.page.offset, s.rows.map(r => r.catalogId)]);
            if (key !== listKey) {
                listKey = key;
                observer?.disconnect();
                nodes.clear();
                list.replaceChildren();
                list.scrollTop = 0;
                for (const row of s.rows) {
                    const item = el("div", "", "source-row");
                    item.dataset.catalogId = row.catalogId;
                    item.setAttribute("role", "listitem");
                    const open = el("button", "", "source-open");
                    open.type = "button";
                    const texts = el("span", "", "source-text"), rowTitle = el("span", "", "source-title"), summary = el("span", "", "source-summary");
                    texts.append(rowTitle, summary);
                    open.append(deps.badge(doc, s.group.agentId), texts);
                    open.addEventListener("click", () => {
                        const before = selectionKey;
                        model.select(row.catalogId);
                        // The embedded viewer can be explicitly closed without clearing this
                        // list's selection. Reselecting it reopens that viewer, but a name
                        // notification never invokes select or triggers another content read.
                        if (before === selectionKey && content) {
                            const current = content;
                            void current.select(row.catalogId).catch(() => { if (current === content)
                                contentRoot.textContent = "無法載入內容，請重新選取對話。"; });
                        }
                        selectedTitle.focus({ preventScroll: true });
                        detail.scrollIntoView({ block: "start", behavior: "instant" });
                    });
                    const retry = button("讀名稱", () => model.retryName(row.catalogId), item);
                    retry.className = "source-name-retry";
                    item.prepend(open);
                    list.append(item);
                    nodes.set(row.catalogId, { row: item, open, title: rowTitle, summary, retry });
                }
                observeRows(key);
            }
            for (const row of s.rows) {
                const node = nodes.get(row.catalogId);
                node.title.textContent = title(row);
                node.title.title = row.metadata?.nativeTitle ?? "";
                node.open.disabled = s.busy || s.page?.stale === true;
                node.open.setAttribute("aria-pressed", String(s.selected?.catalogId === row.catalogId && s.selected.sourceId === s.group.sourceId));
                node.summary.textContent = row.error ? deps.describeError(row.error) : row.metadata?.summary ? `原生摘要：${row.metadata.summary}` : row.status === "loaded" ? "沒有原生摘要" : "Claude Code · 唯讀";
                node.retry.textContent = row.status === "loaded" ? "✓" : row.status === "loading" ? "…" : "讀名稱";
                node.retry.setAttribute("aria-disabled", String(s.busy || s.page?.stale === true || ["loaded", "loading"].includes(row.status)));
                node.retry.setAttribute("aria-label", `${row.status === "loaded" ? "名稱已載入" : "讀取名稱"}：本頁第 ${s.rows.findIndex(r => r.catalogId === row.catalogId) + 1} 個對話`);
            }
            const selected = s.selected, nextKey = selected ? JSON.stringify([selected.sourceId, selected.snapshotId, selected.catalogId]) : null;
            if (nextKey !== selectionKey) {
                selectionKey = nextKey;
                titleExpanded = false;
                summaryDetails.open = false;
                const old = content;
                content = null;
                contentRoot.replaceChildren();
                detail.hidden = !selected;
                if (old)
                    closing = old.close().catch(() => { }).then(() => { closing = null; startContent(); });
                startContent(); // A single pending cleanup always opens the latest selection, not a queued click.
            }
            selectedTitle.textContent = selected ? title(selected) : "";
            selectedTitle.className = titleExpanded ? "source-full-title" : "source-compact-title";
            titleToggle.hidden = selectedTitle.textContent.length <= 32;
            titleToggle.textContent = titleExpanded ? "收合名稱" : "展開完整名稱";
            titleToggle.setAttribute("aria-expanded", String(titleExpanded));
            selectedSummary.textContent = selected?.metadata?.summary ?? "";
            summaryDetails.hidden = !selectedSummary.textContent;
            selectedWarning.hidden = !selected || selected.snapshotId === s.page?.snapshotId && !s.page?.stale;
            selectedWarning.textContent = "這是先前選取的對話與名稱，清單版本已改變。重新選取清單中的對話可開啟目前版本。";
        }
        const back = button("回到對話清單", () => {
            const selected = model.state().selected, node = selected ? nodes.get(selected.catalogId) : null;
            if (node && !node.open.disabled)
                node.open.focus();
            else
                list.focus();
        }, detail);
        detail.prepend(back);
        const hidden = () => { if (doc.hidden)
            model.pauseNames(); };
        doc.addEventListener("visibilitychange", hidden);
        render();
        void model.start();
        return Object.freeze({ model, async close() { observer?.disconnect(); doc.removeEventListener("visibilitychange", hidden); model.close(); await closing; } });
    }
    StepsembleHistorySources.create = create;
})(StepsembleHistorySources || (StepsembleHistorySources = {}));
if (typeof module !== "undefined")
    module.exports = StepsembleHistorySources;
