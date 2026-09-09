"use strict";
/// <reference path="./history-transport.ts" />
/// <reference path="./history-i18n.ts" />
/// <reference path="./codex-history-records.ts" />
/// <reference path="./agent-identity.ts" />
/** Explicit raw-record reader, not a fabricated native chat projection. One
 * page in memory, native scrolling, lazy raw details, no URLs or execution. */
var StepsembleCodexHistoryView;
(function (StepsembleCodexHistoryView) {
    const i18n = typeof module !== "undefined" ? require("./history-i18n") : StepsembleHistoryI18n;
    const wire = typeof module !== "undefined" ? require("./codex-history-records") : StepsembleCodexHistoryRecords;
    const identity = typeof module !== "undefined" ? require("./agent-identity") : StepsembleAgentIdentity;
    StepsembleCodexHistoryView.LIMITS = Object.freeze({ pageRecords: 10, previewUnits: 4000, retainedPages: 1 });
    const same = (a, b) => a?.bindingId === b.bindingId && a.generation === b.generation && a.sessionId === b.sessionId;
    function createModel(deps) {
        if (!/^codex-[a-f0-9]{64}$/.test(deps.catalogId) || !/^[a-f0-9-]{36}$/.test(deps.viewId) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(deps.hostId)
            || ![deps.transport?.register, deps.transport?.readCodex, deps.transport?.release, deps.canonicalJSON, deps.requestId].every(v => typeof v === "function"))
            throw new Error("history_view_dependencies_required");
        let binding = null, page = null, offsets = [0], pageIndex = 0, epoch = 0;
        let structured = deps.initialStructured === true;
        let selected = false, closed = false, busy = false, stale = false, error = null, cleanupPending = false;
        let stage = "choose", flight = null, closing = null;
        const notify = () => deps.onChange?.();
        function state() {
            const expired = !!binding && (deps.now ?? Date.now)() >= binding.expiresAt;
            return structuredClone({ selected, closed, busy, stale: stale || expired, error, stage, cleanupPending, page, pageIndex, structured,
                canPrevious: !busy && !stale && !expired && !!page && pageIndex > 0,
                canNext: !busy && !stale && !expired && !!page && page.history.records.nextOffset !== null });
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
        function fail(code) {
            error = code;
            stale = page !== null;
            if (["history_unauthorized", "history_principal_unavailable", "history_source_unavailable"].includes(code)) {
                page = null;
                offsets = [0];
                pageIndex = 0;
            }
        }
        async function load(mode, target, interruptPrevious = true) {
            if (!selected || closed || mode !== "refresh" && busy)
                return;
            if (mode !== "refresh" && state().stale) {
                fail("history_refresh_required");
                notify();
                return;
            }
            const ticket = ++epoch, previous = flight, readStructured = structured;
            if (interruptPrevious)
                previous?.controller.abort();
            busy = true;
            error = null;
            stage = "preparing";
            notify();
            await previous?.done;
            if (ticket !== epoch || closed || !selected)
                return;
            let done;
            const current = { controller: new AbortController(), done: new Promise(resolve => { done = resolve; }) };
            flight = current;
            const live = () => ticket === epoch && !closed && selected && !current.controller.signal.aborted;
            try {
                const reg = await deps.transport.register({ catalogId: deps.catalogId, viewId: deps.viewId }, current.controller.signal);
                if (!live()) {
                    if (reg.kind === "history_registration" && !same(binding, reg))
                        await release(reg);
                    return;
                }
                if (reg.kind !== "history_registration") {
                    fail(reg.code);
                    return;
                }
                const changed = !same(binding, reg);
                binding = reg;
                if (changed && mode !== "refresh") {
                    fail("history_binding_unavailable");
                    return;
                }
                const offset = mode === "refresh" ? 0 : mode === "jump" ? target : mode === "previous" ? offsets[pageIndex - 1] : page?.history.records.nextOffset;
                if (offset == null || mode !== "refresh" && !page) {
                    fail("history_refresh_required");
                    return;
                }
                const request = { bindingId: reg.bindingId, generation: reg.generation, requestId: deps.requestId() }, selection = { offset, limit: StepsembleCodexHistoryView.LIMITS.pageRecords };
                const version = mode === "refresh" ? undefined : page.sourceVersion;
                stage = "reading";
                notify();
                const raw = await deps.transport.readCodex({ hostId: deps.hostId, bindingId: reg.bindingId, generation: reg.generation, sessionId: reg.sessionId }, request, { page: selection, signal: current.controller.signal, ...(version === undefined ? {} : { version }), ...(readStructured ? { structured: true } : {}) });
                if (!live())
                    return;
                const encoded = deps.canonicalJSON(raw, wire.LIMITS.responseBytes), value = encoded === null ? null : JSON.parse(encoded);
                if (value?.kind === "source_unavailable") {
                    fail(typeof value.code === "string" && Object.hasOwn(i18n.errors, value.code) ? value.code : "history_transport_failed");
                    return;
                }
                if (!wire.validBoundRecords(value, reg.sessionId, selection, { ...request, ...(version === undefined ? {} : { version }), ...(readStructured ? { structured: true } : {}) })) {
                    fail("history_response_invalid");
                    return;
                }
                const records = value.history.records, prior = page?.history.records;
                if (mode !== "refresh" && prior && (records.sha256 !== prior.sha256 || records.byteLength !== prior.byteLength || records.recordCount !== prior.recordCount
                    || value.history.nativeTitle !== page?.history.nativeTitle
                    || mode === "previous" && records.nextOffset !== prior.offset
                    || mode === "next" && records.records[0]?.byteOffset !== (prior.records.at(-1).byteOffset + prior.records.at(-1).byteLength))) {
                    fail("history_response_invalid");
                    return;
                }
                if (mode === "refresh" || mode === "jump") {
                    offsets = [offset];
                    pageIndex = 0;
                }
                else if (mode === "previous")
                    pageIndex--;
                else {
                    pageIndex++;
                    offsets[pageIndex] = offset;
                    offsets.length = pageIndex + 1;
                }
                page = value;
                stale = false;
                error = null;
                stage = "loaded";
            }
            catch (cause) {
                if (live()) {
                    const code = cause?.code;
                    fail(typeof code === "string" && Object.hasOwn(i18n.errors, code) ? code : "history_transport_failed");
                }
            }
            finally {
                if (flight === current)
                    flight = null;
                done();
                if (ticket === epoch) {
                    busy = false;
                    if (error)
                        stage = "failed";
                    notify();
                }
            }
        }
        function cancel() { epoch++; flight?.controller.abort(); busy = false; stage = "cancelled"; notify(); }
        function close() {
            if (closing)
                return closing;
            cancel();
            selected = false;
            closed = true;
            page = null;
            offsets = [0];
            pageIndex = 0;
            stale = false;
            error = null;
            stage = "closed";
            notify();
            const pending = flight?.done;
            closing = (async () => { await pending; const old = binding; binding = null; await release(old); notify(); })().finally(() => { closing = null; });
            return closing;
        }
        async function select(catalogId) {
            if (catalogId !== deps.catalogId || selected && !closed)
                return;
            if (closing)
                await closing;
            selected = true;
            closed = false;
            await load("refresh");
        }
        function navigate(mode) {
            const s = state();
            // A lease can expire between renders. Clicking the still-visible control
            // must explain expiry and repaint disabled controls, not silently do nothing.
            if ((s.selected && !s.closed && !s.busy && s.stale) || (mode === "next" ? s.canNext : s.canPrevious))
                return load(mode);
            return Promise.resolve();
        }
        async function setStructured(value) {
            if (typeof value !== "boolean" || value === structured)
                return;
            structured = value;
            page = null;
            offsets = [0];
            pageIndex = 0;
            stale = false;
            error = null;
            notify();
            // A local fetch abort is not proof that the Host reader has closed.
            // Display changes discard the old page immediately, but await its
            // bounded response/cleanup receipt before asking for a different shape.
            // Explicit cancel/close still abort; no second reader is queued here.
            await load("refresh", undefined, false);
        }
        function jump(recordIndex) {
            if (!Number.isSafeInteger(recordIndex) || recordIndex < 0 || !page || recordIndex >= page.history.records.recordCount)
                return Promise.resolve();
            return load("jump", recordIndex);
        }
        return Object.freeze({ state, select, close, cancel, setStructured, jump, refresh: () => load("refresh"), next: () => navigate("next"), previous: () => navigate("previous") });
    }
    StepsembleCodexHistoryView.createModel = createModel;
    /** Only a compact display excerpt; original text remains in the raw record. */
    function excerpt(row) {
        try {
            const v = JSON.parse(row.rawText), p = v.payload;
            if (v.type === "response_item" && p?.type === "message" && Array.isArray(p.content))
                return p.content.filter((c) => ["input_text", "output_text", "text"].includes(c?.type ?? "") && typeof c.text === "string").map((c) => c.text).join("\n");
            if (v.type === "event_msg" && ["user_message", "agent_message"].includes(p?.type) && typeof p.message === "string")
                return p.message;
            for (const key of ["arguments", "output", "text"])
                if (typeof p?.[key] === "string")
                    return p[key];
            return JSON.stringify(p ?? v, null, 2);
        }
        catch {
            return row.rawText;
        }
    }
    StepsembleCodexHistoryView.excerpt = excerpt;
    function create(deps) {
        const doc = deps.root.ownerDocument;
        const el = (tag, text = "", className = "") => { const v = doc.createElement(tag); i18n.raw(v, text); v.className = className; return v; };
        const copy = (tag, key, className = "") => i18n.bind(el(tag, "", className), key);
        const title = el("h3", "", "codex-record-title"), note = copy("p", "codexRecordsNote", "history-footnote"), toolbar = el("nav", "", "history-toolbar");
        i18n.bind(toolbar, "paging", {}, "aria-label");
        const status = el("p", "", "history-status"), warning = el("p", "", "history-warning"), position = el("p", "", "history-position"), content = el("section", "", "history-messages"), cleanup = el("p", "", "history-footnote");
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        warning.setAttribute("role", "status");
        i18n.bind(content, "codexRecords", {}, "aria-label");
        let rendered = null;
        const model = createModel({ ...deps, initialStructured: deps.initialStructured ?? true, onChange: () => { render(); deps.onChange?.(); } });
        const modes = el("div", "", "codex-history-modes");
        const modeButton = (value) => {
            const v = copy("button", value ? "codexReadable" : "codexRawMode");
            v.type = "button";
            v.dataset.historyMode = value ? "structured" : "raw";
            v.addEventListener("click", () => { void model.setStructured(value); });
            modes.append(v);
            return v;
        };
        const readable = modeButton(true), rawMode = modeButton(false);
        const button = (action) => {
            const v = copy("button", action);
            v.type = "button";
            v.dataset.action = action;
            v.addEventListener("click", () => { void model[action](); });
            toolbar.append(v);
            return v;
        };
        const refresh = button("refresh"), previous = button("previous"), next = button("next"), cancel = button("cancel"), close = button("close");
        deps.root.dataset.i18nIgnore = "";
        deps.root.classList?.add("codex-record-view");
        deps.root.replaceChildren(title, modes, note, toolbar, status, warning, position, content, cleanup);
        function render() {
            const s = model.state(), r = s.page?.history.records;
            deps.root.setAttribute("aria-busy", String(s.busy));
            readable.setAttribute("aria-pressed", String(s.structured));
            rawMode.setAttribute("aria-pressed", String(!s.structured));
            i18n.bind(note, s.structured ? "codexStructuredNote" : "codexRecordsNote");
            i18n.bind(status, s.stage);
            warning.hidden = !s.error && !s.stale;
            i18n.bind(warning, s.error ? i18n.errorKey(s.error) : "pageStale");
            if (s.page?.history.nativeTitle != null)
                i18n.raw(title, s.page.history.nativeTitle);
            else
                i18n.bind(title, "codexRecords");
            refresh.disabled = !s.selected;
            previous.disabled = !s.canPrevious;
            next.disabled = !s.canNext;
            cancel.disabled = !s.busy;
            close.disabled = !s.selected;
            i18n.bind(cleanup, s.cleanupPending ? "cleanupPending" : "cleanupSafe");
            i18n.bind(position, "codexRecordPosition", { start: r?.records.length ? r.offset + 1 : 0, end: r ? r.offset + r.records.length : 0, total: r?.recordCount ?? 0 });
            const key = s.page ? `${s.page.sourceVersion}:${r.offset}:${s.structured}` : null;
            if (key === rendered)
                return;
            rendered = key;
            content.replaceChildren();
            if (!r)
                return;
            let opened = null;
            const structure = s.page?.history.structure, turns = new Map(structure?.turns.map(t => [t.turnKey, t]));
            let priorTurn = null;
            for (const row of r.records) {
                const annotation = structure?.annotations[row.recordIndex - r.offset], turn = annotation?.turnKey ? turns.get(annotation.turnKey) : null;
                if (turn && turn.turnKey !== priorTurn) {
                    const section = el("header", "", "codex-history-turn");
                    section.dataset.turnKey = turn.turnKey;
                    section.dataset.branchState = turn.branchState;
                    const label = copy("h4", turn.boundary === "explicit" ? "codexTurn" : "codexInferredTurn");
                    i18n.bind(label, turn.boundary === "explicit" ? "codexTurn" : "codexInferredTurn", { record: turn.firstRecordIndex + 1 });
                    section.append(label);
                    if (turn.nativeTurnId !== null)
                        section.append(el("p", turn.nativeTurnId, "history-footnote"));
                    const statusLabel = el("p", "", "history-footnote");
                    const statuses = { unknown: "codexStatusUnknown", started: "codexStatusStarted", completed: "codexStatusCompleted", failed: "codexStatusFailed", interrupted: "codexStatusInterrupted" };
                    statusLabel.append(copy("span", "codexRecordedStatus"), el("span", " · "), copy("span", statuses[turn.recordedStatus]));
                    section.append(statusLabel);
                    if (turn.branchState === "rolled_back")
                        section.append(copy("p", "codexRolledBack", "history-warning"));
                    content.append(section);
                }
                priorTurn = annotation?.turnKey ?? null;
                const article = el("article", "", "history-message codex-record"), heading = el("h4", `${row.recordIndex + 1} · ${row.recordType}${row.payloadType ? ` / ${row.payloadType}` : ""}`);
                if (annotation) {
                    article.dataset.recordKind = annotation.kind;
                    article.dataset.branchState = turn?.branchState ?? "retained";
                    const label = el("span");
                    if (annotation.kind === "assistant") {
                        heading.replaceChildren(identity.create(doc, "codex", true), el("span", "Codex"));
                    }
                    else {
                        const labels = { user: "you", reasoning: "thinking", tool: annotation.tool?.phase === "end" ? "toolResult" : "toolUse", model_context: "codexModelContext", metadata: "codexMetadata", lifecycle: "system" };
                        i18n.bind(label, labels[annotation.kind] ?? "other");
                        heading.replaceChildren(label);
                    }
                    heading.append(el("span", ` · ${row.recordIndex + 1}`, "history-footnote"));
                }
                const text = excerpt(row), preview = el("p", annotation ? text : text.slice(0, StepsembleCodexHistoryView.LIMITS.previewUnits), "history-message-text");
                preview.tabIndex = 0;
                preview.setAttribute("aria-labelledby", heading.id = `codex-record-${row.recordIndex}`);
                article.append(heading);
                if (annotation && !["user", "assistant", "reasoning", "tool"].includes(annotation.kind)) {
                    const auxiliary = el("details", "", "codex-history-auxiliary");
                    auxiliary.append(copy("summary", "codexExpand"), preview);
                    article.append(auxiliary);
                }
                else
                    article.append(preview);
                if (!annotation && text.length > StepsembleCodexHistoryView.LIMITS.previewUnits)
                    article.append(copy("p", "truncated", "history-footnote"));
                if (annotation?.warnings.length) {
                    const warnings = el("p", "", "history-footnote");
                    warnings.append(copy("span", "codexWarnings"), el("span", ` · ${annotation.warnings.join(", ")}`));
                    article.append(warnings);
                }
                if (annotation?.tool) {
                    article.append(el("p", `${annotation.tool.family} · ${annotation.tool.nativeCallId}`, "history-footnote"));
                    const related = annotation.tool.relatedRecordIndex;
                    if (related !== null) {
                        const reference = copy("button", "codexRelatedRecord");
                        i18n.bind(reference, "codexRelatedRecord", { record: related + 1 });
                        reference.type = "button";
                        reference.dataset.relatedRecord = String(related);
                        reference.addEventListener("click", () => {
                            void model.jump(related).then(() => {
                                if (model.state().page?.history.records.offset !== related)
                                    return;
                                const target = content.querySelector(`#codex-record-${related}`);
                                if (target) {
                                    target.tabIndex = -1;
                                    target.focus();
                                }
                            });
                        });
                        article.append(reference);
                    }
                }
                const details = el("details"), summary = copy("summary", "codexRawRecord"), pre = el("pre", "", "history-inert-data");
                pre.tabIndex = 0;
                i18n.bind(pre, "codexRawRecord", {}, "aria-label");
                details.append(summary, pre);
                details.addEventListener("toggle", () => {
                    if (details.open) {
                        if (opened && opened.details !== details) {
                            opened.details.open = false;
                            i18n.raw(opened.pre, "");
                        }
                        opened = { details, pre };
                        i18n.raw(pre, row.rawText);
                    }
                    else {
                        i18n.raw(pre, "");
                        if (opened?.details === details)
                            opened = null;
                    }
                });
                article.append(details);
                content.append(article);
            }
        }
        render();
        return Object.freeze({ ...model, model });
    }
    StepsembleCodexHistoryView.create = create;
})(StepsembleCodexHistoryView || (StepsembleCodexHistoryView = {}));
if (typeof module !== "undefined")
    module.exports = StepsembleCodexHistoryView;
