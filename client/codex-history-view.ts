/// <reference path="./history-transport.ts" />
/// <reference path="./history-i18n.ts" />
/// <reference path="./codex-history-records.ts" />
declare function require(name: "./history-i18n"): typeof StepsembleHistoryI18n;
declare function require(name: "./codex-history-records"): typeof StepsembleCodexHistoryRecords;
/** Explicit raw-record reader, not a fabricated native chat projection. One
 * page in memory, native scrolling, lazy raw details, no URLs or execution. */
namespace StepsembleCodexHistoryView {
  const i18n = typeof module !== "undefined" ? require("./history-i18n") : StepsembleHistoryI18n;
  const wire = typeof module !== "undefined" ? require("./codex-history-records") : StepsembleCodexHistoryRecords;
  type Registration = StepsembleHistoryTransport.Registration;
  type Bound = StepsembleCodexHistoryRecords.Bound;
  export const LIMITS = Object.freeze({ pageRecords: 10, previewUnits: 4000, retainedPages: 1 });
  export interface Dependencies {
    hostId: string; viewId: string; catalogId: string;
    transport: Pick<ReturnType<typeof StepsembleHistoryTransport.create>, "register" | "readCodex" | "release">;
    canonicalJSON(value: unknown, limit: number): string | null; requestId(): string; now?(): number; onChange?(): void;
  }
  const same = (a: Registration | null, b: Registration) => a?.bindingId === b.bindingId && a.generation === b.generation && a.sessionId === b.sessionId;
  export function createModel(deps: Dependencies) {
    if (!/^codex-[a-f0-9]{64}$/.test(deps.catalogId) || !/^[a-f0-9-]{36}$/.test(deps.viewId) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(deps.hostId)
      || ![deps.transport?.register, deps.transport?.readCodex, deps.transport?.release, deps.canonicalJSON, deps.requestId].every(v => typeof v === "function")) throw new Error("history_view_dependencies_required");
    let binding: Registration | null = null, page: Bound | null = null, offsets = [0], pageIndex = 0, epoch = 0;
    let selected = false, closed = false, busy = false, stale = false, error: string | null = null, cleanupPending = false;
    let stage: StepsembleHistoryI18n.Key = "choose", flight: { controller: AbortController; done: Promise<void> } | null = null, closing: Promise<void> | null = null;
    const notify = () => deps.onChange?.();
    function state() {
      const expired = !!binding && (deps.now ?? Date.now)() >= binding.expiresAt;
      return structuredClone({ selected, closed, busy, stale: stale || expired, error, stage, cleanupPending, page, pageIndex,
        canPrevious: !busy && !stale && !expired && !!page && pageIndex > 0,
        canNext: !busy && !stale && !expired && !!page && page.history.records.nextOffset !== null });
    }
    async function release(row: Registration | null) {
      if (!row) return;
      try { const result = await deps.transport.release({ bindingId: row.bindingId, generation: row.generation });
        if (result.kind !== "history_released" || !result.cleanupConfirmed) cleanupPending = true;
      } catch { cleanupPending = true; }
    }
    function fail(code: string) {
      error = code; stale = page !== null;
      if (["history_unauthorized", "history_principal_unavailable", "history_source_unavailable"].includes(code)) { page = null; offsets = [0]; pageIndex = 0; }
    }
    async function load(mode: "refresh" | "next" | "previous") {
      if (!selected || closed || mode !== "refresh" && busy) return;
      if (mode !== "refresh" && state().stale) { fail("history_refresh_required"); notify(); return; }
      const ticket = ++epoch, previous = flight; previous?.controller.abort(); busy = true; error = null; stage = "preparing"; notify();
      await previous?.done;
      if (ticket !== epoch || closed || !selected) return;
      let done!: () => void;
      const current = { controller: new AbortController(), done: new Promise<void>(resolve => { done = resolve; }) }; flight = current;
      const live = () => ticket === epoch && !closed && selected && !current.controller.signal.aborted;
      try {
        const reg = await deps.transport.register({ catalogId: deps.catalogId, viewId: deps.viewId }, current.controller.signal);
        if (!live()) { if (reg.kind === "history_registration" && !same(binding, reg)) await release(reg); return; }
        if (reg.kind !== "history_registration") { fail(reg.code); return; }
        const changed = !same(binding, reg); binding = reg;
        if (changed && mode !== "refresh") { fail("history_binding_unavailable"); return; }
        const offset = mode === "refresh" ? 0 : mode === "previous" ? offsets[pageIndex - 1] : page?.history.records.nextOffset;
        if (offset == null || mode !== "refresh" && !page) { fail("history_refresh_required"); return; }
        const request = { bindingId: reg.bindingId, generation: reg.generation, requestId: deps.requestId() }, selection = { offset, limit: LIMITS.pageRecords };
        const version = mode === "refresh" ? undefined : page!.sourceVersion;
        stage = "reading"; notify();
        const raw = await deps.transport.readCodex({ hostId: deps.hostId, bindingId: reg.bindingId, generation: reg.generation, sessionId: reg.sessionId }, request,
          { page: selection, signal: current.controller.signal, ...(version === undefined ? {} : { version }) });
        if (!live()) return;
        const encoded = deps.canonicalJSON(raw, wire.LIMITS.responseBytes), value = encoded === null ? null : JSON.parse(encoded);
        if (value?.kind === "source_unavailable") { fail(typeof value.code === "string" && Object.hasOwn(i18n.errors, value.code) ? value.code : "history_transport_failed"); return; }
        if (!wire.validBoundRecords(value, reg.sessionId, selection, { ...request, ...(version === undefined ? {} : { version }) })) { fail("history_response_invalid"); return; }
        const records = value.history.records, prior = page?.history.records;
        if (mode !== "refresh" && prior && (records.sha256 !== prior.sha256 || records.byteLength !== prior.byteLength || records.recordCount !== prior.recordCount
          || value.history.nativeTitle !== page?.history.nativeTitle
          || mode === "previous" && records.nextOffset !== prior.offset
          || mode === "next" && records.records[0]?.byteOffset !== (prior.records.at(-1)!.byteOffset + prior.records.at(-1)!.byteLength))) { fail("history_response_invalid"); return; }
        if (mode === "refresh") { offsets = [0]; pageIndex = 0; }
        else if (mode === "previous") pageIndex--;
        else { pageIndex++; offsets[pageIndex] = offset; offsets.length = pageIndex + 1; }
        page = value; stale = false; error = null; stage = "loaded";
      } catch (cause) {
        if (live()) { const code = (cause as { code?: unknown })?.code; fail(typeof code === "string" && Object.hasOwn(i18n.errors, code) ? code : "history_transport_failed"); }
      } finally {
        if (flight === current) flight = null; done();
        if (ticket === epoch) { busy = false; if (error) stage = "failed"; notify(); }
      }
    }
    function cancel() { epoch++; flight?.controller.abort(); busy = false; stage = "cancelled"; notify(); }
    function close(): Promise<void> {
      if (closing) return closing;
      cancel(); selected = false; closed = true; page = null; offsets = [0]; pageIndex = 0; stale = false; error = null; stage = "closed"; notify();
      const pending = flight?.done;
      closing = (async () => { await pending; const old = binding; binding = null; await release(old); notify(); })().finally(() => { closing = null; });
      return closing;
    }
    async function select(catalogId: string) {
      if (catalogId !== deps.catalogId || selected && !closed) return;
      if (closing) await closing;
      selected = true; closed = false; await load("refresh");
    }
    function navigate(mode: "next" | "previous") {
      const s = state();
      // A lease can expire between renders. Clicking the still-visible control
      // must explain expiry and repaint disabled controls, not silently do nothing.
      if ((s.selected && !s.closed && !s.busy && s.stale) || (mode === "next" ? s.canNext : s.canPrevious)) return load(mode);
      return Promise.resolve();
    }
    return Object.freeze({ state, select, close, cancel, refresh: () => load("refresh"), next: () => navigate("next"), previous: () => navigate("previous") });
  }
  /** Only a compact display excerpt; original text remains in the raw record. */
  export function excerpt(row: StepsembleCodexHistoryRecords.RawRecord): string {
    try {
      const v = JSON.parse(row.rawText), p = v.payload;
      if (v.type === "response_item" && p?.type === "message" && Array.isArray(p.content))
        return p.content.filter((c: { type?: string; text?: unknown }) => ["input_text", "output_text", "text"].includes(c?.type ?? "") && typeof c.text === "string").map((c: { text: string }) => c.text).join("\n");
      if (v.type === "event_msg" && ["user_message", "agent_message"].includes(p?.type) && typeof p.message === "string") return p.message;
      for (const key of ["arguments", "output", "text"]) if (typeof p?.[key] === "string") return p[key];
      return JSON.stringify(p ?? v, null, 2);
    } catch { return row.rawText; }
  }
  export function create(deps: Dependencies & { root: HTMLElement }) {
    const doc = deps.root.ownerDocument;
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") => { const v = doc.createElement(tag); i18n.raw(v, text); v.className = className; return v; };
    const copy = <K extends keyof HTMLElementTagNameMap>(tag: K, key: StepsembleHistoryI18n.Key, className = "") => i18n.bind(el(tag, "", className), key);
    const title = el("h3", "", "codex-record-title"), note = copy("p", "codexRecordsNote", "history-footnote"), toolbar = el("nav", "", "history-toolbar");
    i18n.bind(toolbar, "paging", {}, "aria-label");
    const status = el("p", "", "history-status"), warning = el("p", "", "history-warning"), position = el("p", "", "history-position"), content = el("section", "", "history-messages"), cleanup = el("p", "", "history-footnote");
    status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); warning.setAttribute("role", "status");
    i18n.bind(content, "codexRecords", {}, "aria-label");
    let rendered: string | null = null;
    const model = createModel({ ...deps, onChange: () => { render(); deps.onChange?.(); } });
    const button = (action: "refresh" | "previous" | "next" | "cancel" | "close") => {
      const v = copy("button", action); v.type = "button"; v.dataset.action = action; v.addEventListener("click", () => { void model[action](); }); toolbar.append(v); return v;
    };
    const refresh = button("refresh"), previous = button("previous"), next = button("next"), cancel = button("cancel"), close = button("close");
    deps.root.dataset.i18nIgnore = ""; deps.root.classList?.add("codex-record-view"); deps.root.replaceChildren(note, title, toolbar, status, warning, position, content, cleanup);
    function render() {
      const s = model.state(), r = s.page?.history.records; deps.root.setAttribute("aria-busy", String(s.busy));
      i18n.bind(status, s.stage); warning.hidden = !s.error && !s.stale; i18n.bind(warning, s.error ? i18n.errorKey(s.error) : "pageStale");
      if (s.page?.history.nativeTitle != null) i18n.raw(title, s.page.history.nativeTitle); else i18n.bind(title, "codexRecords");
      refresh.disabled = !s.selected; previous.disabled = !s.canPrevious; next.disabled = !s.canNext; cancel.disabled = !s.busy; close.disabled = !s.selected;
      i18n.bind(cleanup, s.cleanupPending ? "cleanupPending" : "cleanupSafe");
      i18n.bind(position, "codexRecordPosition", { start: r?.records.length ? r.offset + 1 : 0, end: r ? r.offset + r.records.length : 0, total: r?.recordCount ?? 0 });
      const key = s.page ? `${s.page.sourceVersion}:${r!.offset}` : null;
      if (key === rendered) return; rendered = key; content.replaceChildren();
      if (!r) return;
      let opened: { details: HTMLDetailsElement; pre: HTMLPreElement } | null = null;
      for (const row of r.records) {
        const article = el("article", "", "history-message codex-record"), heading = el("h4", `${row.recordIndex + 1} · ${row.recordType}${row.payloadType ? ` / ${row.payloadType}` : ""}`);
        const text = excerpt(row), preview = el("p", text.slice(0, LIMITS.previewUnits), "history-message-text");
        preview.tabIndex = 0; preview.setAttribute("aria-labelledby", heading.id = `codex-record-${row.recordIndex}`);
        article.append(heading, preview); if (text.length > LIMITS.previewUnits) article.append(copy("p", "truncated", "history-footnote"));
        const details = el("details"), summary = copy("summary", "codexRawRecord"), pre = el("pre", "", "history-inert-data");
        pre.tabIndex = 0; i18n.bind(pre, "codexRawRecord", {}, "aria-label");
        details.append(summary, pre); details.addEventListener("toggle", () => {
          if (details.open) {
            if (opened && opened.details !== details) { opened.details.open = false; i18n.raw(opened.pre, ""); }
            opened = { details, pre }; i18n.raw(pre, row.rawText);
          } else { i18n.raw(pre, ""); if (opened?.details === details) opened = null; }
        });
        article.append(details); content.append(article);
      }
    }
    render(); return Object.freeze({ ...model, model });
  }
}
if (typeof module !== "undefined") module.exports = StepsembleCodexHistoryView;
