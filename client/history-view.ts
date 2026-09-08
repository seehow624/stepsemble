/// <reference path="./history-transport.ts" />
/// <reference path="./claude-history.ts" />
/// <reference path="./projection.ts" />
/** Isolated inert-history preview. Only trusted catalog IDs reach the transport;
 * native text never becomes HTML, a URL, an executable action or authority. */
namespace StepsembleHistoryView {
  type Pages = ReturnType<typeof StepsembleHistoryPages.create>;
  type Transport = Pick<ReturnType<typeof StepsembleHistoryTransport.create>, "register" | "read" | "release">;
  type Entry = StepsembleHistoryTransport.CatalogEntry;
  type Registration = StepsembleHistoryTransport.Registration;
  type ObjectValue = Record<string, unknown>;
  export const LIMITS = Object.freeze({ messages: 10, blocks: 24, textUnits: 48000, blockTextUnits: 8000, evidence: 20 });
  export interface Dependencies {
    hostId: string; viewId: string; catalog: Entry[]; transport: Transport;
    createPages(read: StepsembleHistoryPages.Dependencies["read"]): Pages;
    now?: () => number;
    onChange?: () => void;
  }
  export interface State {
    selected: Entry | null; busy: boolean; stage: string; error: string | null; stale: boolean; closed: boolean;
    limit: number; pageIndex: number; pageCount: number; messageStart: number; retainedMessages: number;
    canPrevious: boolean; canNext: boolean; page: StepsembleHistoryPages.StoredPage | null;
    cleanupPending: boolean; sourceVersion: string | null;
  }
  const object = (v: unknown): v is ObjectValue => v !== null && typeof v === "object" && !Array.isArray(v);
  const same = (a: Registration | null, b: Registration): boolean => !!a && a.bindingId === b.bindingId && a.generation === b.generation && a.sessionId === b.sessionId;
  const uuid = (v: string): boolean => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
  const messages: Record<string, string> = {
    history_binding_unavailable: "這份歷史的存取已到期，請重新整理。", history_principal_unavailable: "目前的登入已失效，請回到主頁重新登入。",
    history_unauthorized: "目前的登入已失效，請回到主頁重新登入。", history_capacity_unavailable: "目前可用的唯讀名額已滿，請稍後手動重新整理。",
    history_view_conflict: "上一個來源仍在釋放中，請稍後手動重新整理。", source_busy: "來源仍在讀取或收尾中，請稍後手動重新整理。",
    source_version_changed: "來源內容已改變。保留的頁面已過期，請重新整理。", source_version_unavailable: "原版本已不可用，請重新整理。",
    history_version_mismatch: "來源版本已改變，請重新整理。", history_refresh_required: "請先重新整理，再繼續翻頁。",
    source_service_quarantined: "來源服務暫停提供讀取，請聯絡主機管理者。", source_cleanup_unconfirmed: "尚未確認來源讀取已結束，請稍後再試。",
    history_registry_unavailable: "來源服務暫時不可用。", history_registry_closed: "來源服務已關閉。", source_service_closed: "來源服務已關閉。",
    history_transport_failed: "連線未完成，保留原本的頁面。請手動重新整理。", history_timeout: "讀取逾時，請手動重新整理。",
    history_request_timeout: "讀取逾時，請手動重新整理。", history_response_invalid: "回覆未通過驗證，沒有顯示新資料。",
    history_response_too_large: "回覆超過安全上限，請減少每頁則數再重新整理。", source_observation_too_large: "回覆過大，請減少每頁則數再重新整理。",
    history_source_unavailable: "主機尚未啟用這個來源，或目前的憑證沒有讀取權限。", history_view_limit: "已達本次檢視的保留上限，請重新整理目前頁面。",
    source_platform_unsupported: "這台主機尚未支援原生歷史讀取，請選擇已支援的主機。",
    source_containment_unavailable: "來源所在磁碟未通過安全檢查；沒有讀取新內容，也不會自動更改磁碟權限。",
    source_root_identity_changed: "已登記的來源目錄已被替換，請由主機管理者重新確認來源。",
    source_acl_unsupported: "來源權限尚未符合唯讀功能的支援範圍，請由主機管理者檢查。",
  };
  export function describeError(code: string): string { return messages[code] ?? "目前無法取得新資料。請手動重新整理。"; }

  export function createModel(deps: Dependencies) {
    if (!deps || !uuid(deps.viewId) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(deps.hostId) || typeof deps.createPages !== "function"
      || !deps.transport || ![deps.transport.register, deps.transport.read, deps.transport.release].every(v => typeof v === "function")) throw new Error("history_view_dependencies_required");
    const catalog = structuredClone(deps.catalog);
    if (!Array.isArray(catalog) || catalog.length > 256 || catalog.some(e => !object(e) || Object.keys(e).sort().join(",") !== "catalogId,description,label"
      || typeof e.catalogId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(e.catalogId) || typeof e.label !== "string" || !e.label.length || e.label.length > 120 || /[\u0000-\u001f\u007f]/.test(e.label)
      || typeof e.description !== "string" || e.description.length > 300 || /[\u0000-\u001f\u007f]/.test(e.description)) || new Set(catalog.map(e => e.catalogId)).size !== catalog.length) throw new Error("history_catalog_invalid");
    const now = deps.now ?? Date.now;
    let selected: Entry | null = null, binding: Registration | null = null, controller = deps.createPages(deps.transport.read);
    let snapshot = controller.state(), pending: AbortController | null = null, candidate: Pages | null = null;
    let epoch = 0, busy = false, stage = "選擇一個歷史來源", error: string | null = null, stale = false, closed = false;
    let limit = 10, offset: number | null = null, messageStart = 0, cleanupPending = false;
    const notify = () => deps.onChange?.();
    function cancelWork(): void {
      epoch++; pending?.abort(); pending = null; controller.cancel(); candidate?.cancel();
      if (candidate && candidate !== controller) candidate.dispose(); candidate = null; busy = false;
    }
    async function release(row: Registration | null): Promise<void> {
      if (!row) return;
      try { const result = await deps.transport.release({ bindingId: row.bindingId, generation: row.generation });
        if (result.kind !== "history_released" || !result.cleanupConfirmed) cleanupPending = true;
      } catch { cleanupPending = true; }
    }
    function state(): State {
      const found = snapshot.pages.findIndex(p => p.offset === offset), index = Math.max(0, found), page = snapshot.pages[index] ?? null;
      const expired = !!binding && now() >= binding.expiresAt;
      const isStale = stale || snapshot.status === "stale" || expired;
      return structuredClone({ selected, busy, stage, error, stale: isStale, closed, limit, pageIndex: index, pageCount: snapshot.pages.length,
        messageStart, retainedMessages: snapshot.messageCount, cleanupPending, sourceVersion: snapshot.sourceVersion, page,
        canPrevious: !busy && !!page && (index > 0 || !isStale && page.offset > 0),
        canNext: !busy && !!page && (index < snapshot.pages.length - 1 || !isStale && !snapshot.reachedEnd) });
    }
    function showWindow(start: number): void {
      const page = state().page;
      if (page && Number.isSafeInteger(start) && start >= 0 && start < page.observation.messages.length) { messageStart = start; notify(); }
    }
    function setLimit(value: number): void { if ([5, 10, 25].includes(value)) { limit = value; notify(); } }
    async function load(mode: "refresh" | "next" | "previous", selectionEpoch?: number): Promise<void> {
      if (!selected || closed) return;
      if (mode !== "refresh" && busy) return;
      if (selectionEpoch === undefined) cancelWork();
      const ticket = epoch, item = selected, abort = new AbortController(); pending = abort; busy = true; error = null; stage = "準備唯讀歷史…"; notify();
      let target = controller;
      try {
        // Renew only as part of an explicit read. No polling, keepalive timer or
        // automatic retry. An expired lease may produce a different generation.
        const reg = await deps.transport.register({ catalogId: item.catalogId, viewId: deps.viewId }, abort.signal);
        if (ticket !== epoch || abort.signal.aborted) {
          if (reg.kind === "history_registration" && selected?.catalogId !== reg.catalogId && !same(binding, reg)) await release(reg);
          return;
        }
        if (reg.kind !== "history_registration") { error = reg.code; stale = snapshot.pages.length > 0; return; }
        const changed = !same(binding, reg); binding = reg;
        if (changed && mode !== "refresh") { stale = true; error = "history_binding_unavailable"; return; }
        if (changed || !snapshot.scope || snapshot.scope.bindingId !== reg.bindingId || snapshot.scope.generation !== reg.generation) {
          target = deps.createPages(deps.transport.read); candidate = target;
          target.reset({ hostId: deps.hostId, bindingId: reg.bindingId, generation: reg.generation, sessionId: reg.sessionId });
        }
        const requestedOffset = mode === "refresh" ? offset ?? 0 : mode === "previous" ? Math.max(0, (snapshot.startOffset ?? 0) - limit) : snapshot.nextOffset;
        stage = "讀取頁面…";
        const flight = mode === "refresh" ? target.refresh({ offset: requestedOffset ?? 0, limit })
          : mode === "next" ? target.loadNext(limit) : target.loadPrevious(limit);
        notify(); const result = await flight;
        if (ticket !== epoch || abort.signal.aborted) return;
        if (result.kind === "applied") {
          if (target !== controller) { controller.dispose(); controller = target; candidate = null; }
          snapshot = controller.state();
          if (snapshot.pages.some(page => page.offset === requestedOffset)) offset = requestedOffset;
          messageStart = 0; stale = false; error = null; stage = "已載入唯讀頁面";
        } else if (result.kind === "unavailable") {
          error = result.code; stale = snapshot.pages.length > 0;
          if (target === controller) snapshot = controller.state();
        }
      } catch (reason) {
        if (ticket !== epoch || abort.signal.aborted) return;
        error = object(reason) && typeof reason.code === "string" && Object.hasOwn(messages, reason.code) ? reason.code : "history_transport_failed"; stale = snapshot.pages.length > 0;
      } finally {
        if (target !== controller) target.dispose();
        if (ticket === epoch) { candidate = null; pending = null; busy = false; if (error) stage = "未載入新資料"; notify(); }
      }
    }
    async function select(catalogId: string): Promise<void> {
      const item = catalog.find(entry => entry.catalogId === catalogId); if (!item) return;
      if (selected?.catalogId === catalogId && !closed) return;
      cancelWork(); const ticket = epoch, old = binding; binding = null; selected = item; closed = false; error = null; stale = false;
      controller.dispose(); controller = deps.createPages(deps.transport.read); snapshot = controller.state(); offset = null; messageStart = 0;
      busy = true; stage = old ? "切換來源…" : "準備唯讀歷史…"; notify();
      await release(old); if (ticket !== epoch) return;
      await load("refresh", ticket);
    }
    async function navigate(direction: "next" | "previous"): Promise<void> {
      const current = state(); if (busy || !current.page) return;
      const next = current.pageIndex + (direction === "next" ? 1 : -1), cached = snapshot.pages[next];
      if (cached) { offset = cached.offset; messageStart = 0; notify(); return; }
      if (current.stale) { stale = true; error = "history_refresh_required"; notify(); return; }
      if (direction === "next" ? current.canNext : current.canPrevious) await load(direction);
    }
    function cancel(): void { cancelWork(); stage = "已取消讀取；原有頁面仍保留"; notify(); }
    async function close(): Promise<void> {
      cancelWork(); const old = binding; binding = null; selected = null; closed = true; error = null; stale = false;
      controller.dispose(); controller = deps.createPages(deps.transport.read); snapshot = controller.state(); offset = null; messageStart = 0; stage = "已關閉唯讀歷史"; notify();
      await release(old); notify();
    }
    return Object.freeze({ select, refresh: () => load("refresh"), next: () => navigate("next"), previous: () => navigate("previous"), cancel, close, setLimit, showWindow, state });
  }

  export function create(deps: Dependencies & { root: HTMLElement }) {
    const doc = deps.root.ownerDocument;
    const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K] => {
      const node = doc.createElement(tag); node.textContent = text; if (className) node.className = className; return node;
    };
    const tabs = element("nav", "", "history-sources"); tabs.setAttribute("aria-label", "歷史來源");
    const title = element("h2", "選擇歷史來源"), description = element("p", "", "history-description");
    const status = element("p", "", "history-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const warning = element("p", "", "history-warning"); warning.setAttribute("role", "status");
    const toolbar = element("div", "", "history-toolbar"), controls: Record<string, HTMLButtonElement> = {};
    const button = (key: string, label: string, action: () => void | Promise<void>, parent: HTMLElement = toolbar) => {
      const node = element("button", label); node.type = "button"; node.dataset.action = key; node.addEventListener("click", () => { void action(); }); parent.append(node); controls[key] = node; return node;
    };
    const model = createModel({ ...deps, onChange: () => { render(); deps.onChange?.(); } });
    const tabButtons = deps.catalog.map(entry => {
      const node = button("source:" + entry.catalogId, entry.label, () => model.select(entry.catalogId), tabs); node.setAttribute("aria-pressed", "false"); return node;
    });
    button("refresh", "重新整理", () => model.refresh()); button("previous", "上一頁", () => model.previous()); button("next", "下一頁", () => model.next());
    button("cancel", "取消讀取", () => model.cancel()); button("close", "關閉歷史", () => model.close());
    const label = element("label", "每次讀取 ", "history-limit"), select = element("select"); select.setAttribute("aria-label", "每頁訊息數");
    for (const n of [5, 10, 25]) { const option = element("option", n + " 則"); option.value = String(n); select.append(option); } select.value = "10";
    select.addEventListener("change", () => model.setLimit(Number(select.value))); label.append(select); toolbar.append(label);
    const content = element("section", "", "history-messages"); content.setAttribute("aria-label", "歷史訊息");
    const position = element("p", "", "history-position"), windowBar = element("div", "", "history-window-controls");
    button("windowPrevious", "本頁前 10 則", () => model.showWindow(Math.max(0, model.state().messageStart - LIMITS.messages)), windowBar);
    button("windowNext", "本頁後 10 則", () => model.showWindow(model.state().messageStart + LIMITS.messages), windowBar);
    const evidence = element("section", "", "history-evidence"), cleanup = element("p", "", "history-footnote");
    deps.root.replaceChildren(tabs, title, description, toolbar, status, warning, position, content, windowBar, evidence, cleanup);
    let renderedPage: string | null = null, renderedWindow = -1;
    function render(): void {
      const s = model.state(); deps.root.setAttribute("aria-busy", String(s.busy));
      title.textContent = s.selected?.label ?? (s.closed ? "檢視已關閉" : "選擇歷史來源"); description.textContent = s.selected?.description ?? "選擇主機提供的來源。只讀取歷史，不執行或續跑工作。";
      status.textContent = s.stage; warning.hidden = !s.error && !s.stale;
      warning.textContent = s.error ? describeError(s.error) + (s.page ? " 目前仍顯示先前的頁面（可能已過期）。" : "")
        : s.stale ? "這份頁面已過期。請重新整理後再讀取其他頁面。" : "";
      warning.dataset.state = s.stale ? "stale" : "error";
      tabButtons.forEach((node, index) => node.setAttribute("aria-pressed", String(deps.catalog[index].catalogId === s.selected?.catalogId)));
      controls.refresh.disabled = !s.selected; controls.previous.disabled = !s.canPrevious; controls.next.disabled = !s.canNext;
      controls.cancel.disabled = !s.busy; controls.close.disabled = !s.selected && !s.busy;
      controls.windowPrevious.disabled = s.messageStart === 0; controls.windowNext.disabled = !s.page || s.messageStart + LIMITS.messages >= s.page.observation.messages.length;
      select.value = String(s.limit); cleanup.textContent = s.cleanupPending ? "關閉請求已送出；部分讀取尚未確認釋放，主機租約到期會收回唯讀存取。" : "關閉歷史只釋放唯讀存取，不會中止原生工作。";
      const pageKey = s.page ? `${s.sourceVersion}:${s.page.offset}:${s.page.limit}:${s.page.observation.selectionDigest}` : null;
      position.textContent = s.page ? `已保留 ${s.retainedMessages} 則 · 第 ${s.pageIndex + 1} / ${s.pageCount} 個已載入頁面 · 本頁顯示 ${s.page.observation.messages.length ? s.messageStart + 1 : 0}–${Math.min(s.messageStart + LIMITS.messages, s.page.observation.messages.length)} / ${s.page.observation.messages.length} 則 · SDK 位移 ${s.page.offset}` : "尚未讀取訊息";
      windowBar.hidden = !s.page || s.page.observation.messages.length <= LIMITS.messages;
      if (pageKey === renderedPage && s.messageStart === renderedWindow) return;
      renderedPage = pageKey; renderedWindow = s.messageStart; content.replaceChildren(); evidence.replaceChildren();
      if (!s.page) { content.append(element("p", s.closed ? "選擇來源可再次開啟檢視。" : "尚無訊息。請選擇歷史來源。", "history-empty")); return; }
      let remaining = LIMITS.textUnits;
      const clipped = (input: string, maximum: number = LIMITS.blockTextUnits): string => {
        const count = Math.min(remaining, maximum); if (count <= 0) return "［本畫面文字已達顯示上限］";
        const value = input.slice(0, count); remaining -= value.length;
        return input.length > value.length ? value + "\n［長內容已縮短顯示］" : value;
      };
      const details = (heading: string, value: unknown, parent: HTMLElement): void => {
        const node = element("details"), summary = element("summary", heading), pre = element("pre", "", "history-inert-data");
        // Bounded strings are inert even when source text resembles HTML, URLs,
        // scripts or command lines. There is no href/src/innerHTML assignment.
        const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        pre.textContent = clipped(text ?? ""); node.append(summary, pre); parent.append(node);
      };
      const pageMessages = s.page.observation.messages.slice(s.messageStart, s.messageStart + LIMITS.messages);
      if (!pageMessages.length) content.append(element("p", "這一頁沒有訊息。", "history-empty"));
      for (const message of pageMessages) {
        const card = element("article", "", "history-message"), role = message.role === "user" ? "你" : message.role === "assistant" ? "Claude" : "系統紀錄";
        card.append(element("h3", role), element("p", typeof message.originalTimestamp === "string" ? clipped(message.originalTimestamp, 120) : "未提供時間", "history-message-time"));
        const blocks = Array.isArray(message.blocks) ? message.blocks : [];
        for (const block of blocks.slice(0, LIMITS.blocks)) {
          if (!object(block)) continue;
          if (block.kind === "text" && typeof block.text === "string") card.append(element("p", clipped(block.text), "history-message-text"));
          else if (block.kind === "thinking") details("思考紀錄 · 唯讀", block.text, card);
          else if (block.kind === "tool_use") details("工具請求紀錄 · 不執行", block, card);
          else if (block.kind === "tool_result") details("工具結果紀錄 · 不代表已核准", block, card);
          else if (block.kind === "attachment") details("附件描述 · 不載入附件", block, card);
          else details("其他來源紀錄 · 唯讀", block, card);
        }
        if (blocks.length > LIMITS.blocks) card.append(element("p", "此訊息只顯示前 24 個內容區塊。", "history-footnote"));
        content.append(card);
      }
      for (const [key, heading] of [["tools", "本頁工具觀測 · 沒有執行權限"], ["auxiliaryRecords", "附加來源紀錄 · 不載入檔案"], ["warnings", "來源觀測限制"]]) {
        const rows = s.page.observation[key];
        if (Array.isArray(rows) && rows.length) details(`${heading}（${rows.length} 筆，最多顯示 ${LIMITS.evidence} 筆）`, rows.slice(0, LIMITS.evidence), evidence);
      }
    }
    render(); return Object.freeze({ ...model, render });
  }

  export function hostRoute(search: string): { hostId: string; routePrefix: string } {
    const params = new URLSearchParams(search), entries = [...params];
    if (!entries.length) return { hostId: "local", routePrefix: "" };
    if (entries.length !== 1 || entries[0][0] !== "machine" || !/^[a-z0-9-]{1,48}$/.test(entries[0][1])) throw new Error("history_route_invalid");
    return { hostId: entries[0][1], routePrefix: `/r/${entries[0][1]}` };
  }

  export async function bootHost(): Promise<void> {
    const root = document.querySelector<HTMLElement>("[data-history-host]"); if (!root) return;
    const status = document.createElement("p"); status.className = "history-empty"; status.setAttribute("role", "status");
    status.textContent = "正在確認主機提供的唯讀來源…"; root.replaceChildren(status);
    const abort = new AbortController(); let gone = false, view: ReturnType<typeof create> | null = null;
    const close = () => { gone = true; abort.abort(); void view?.close(); };
    window.addEventListener("pagehide", close, { once: true });
    // A bfcache-restored document must not revive an old credential/view scope.
    window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
    const showUnavailable = (message: string) => {
      if (gone) return;
      status.textContent = message;
      const retry = document.createElement("button"); retry.className = "history-button"; retry.type = "button";
      retry.textContent = "重新確認"; retry.addEventListener("click", () => location.reload());
      root.replaceChildren(status, retry);
    };
    try {
      const route = hostRoute(location.search), viewId = crypto.randomUUID(), canonicalJSON = StepsembleProjection.canonicalJSON;
      const label = document.querySelector<HTMLElement>("[data-history-host-label]"); if (label) label.textContent = route.hostId === "local" ? "目前主機" : `遠端主機 · ${route.hostId}`;
      const transport = StepsembleHistoryTransport.create({ ...route, origin: location.origin, viewId, canonicalJSON });
      const result = await transport.catalog(abort.signal); if (gone) return;
      if (result.kind !== "history_catalog") { showUnavailable(describeError(result.code)); return; }
      if (!result.entries.length) { showUnavailable("這個登入尚無可讀取的來源。請由主機管理者明確登記來源與讀取權限；不會自動掃描你的私人對話。"); return; }
      const provider = StepsembleClaudeHistory.create({ canonicalJSON });
      view = create({ root, ...route, viewId, catalog: result.entries, transport,
        createPages: read => StepsembleHistoryPages.create({ read, canonicalJSON, validateHistory: provider.validateHistory, requestId: () => crypto.randomUUID() }) });
    } catch (error) {
      showUnavailable(error instanceof StepsembleHistoryTransport.TransportError ? describeError(error.code)
        : "無法開啟這份唯讀歷史。請返回工作區確認登入和主機，然後手動重試。");
    }
  }

  /** Only the isolated preview document calls this. It has no production import
   * or service-worker registration and accepts no URL-supplied source options. */
  export async function bootPreview(): Promise<void> {
    const root = document.querySelector<HTMLElement>("[data-history-preview]"); if (!root) return;
    const status = document.createElement("p"); status.textContent = "正在讀取範例來源…"; root.replaceChildren(status);
    try {
      const viewId = crypto.randomUUID(), canonicalJSON = StepsembleProjection.canonicalJSON;
      const transport = StepsembleHistoryTransport.create({ origin: location.origin, hostId: "history-preview", viewId, canonicalJSON });
      const result = await transport.catalog();
      if (result.kind !== "history_catalog") { status.textContent = describeError(result.code); return; }
      const provider = StepsembleClaudeHistory.create({ canonicalJSON });
      const view = create({ root, hostId: "history-preview", viewId, catalog: result.entries, transport,
        createPages: read => StepsembleHistoryPages.create({ read, canonicalJSON, validateHistory: provider.validateHistory, requestId: () => crypto.randomUUID() }) });
      window.addEventListener("pagehide", () => { void view.close(); }, { once: true });
    } catch { status.textContent = "這個頁面需要隔離的開發預覽主機。無法載入範例來源。"; }
  }
}
if (typeof module !== "undefined") module.exports = StepsembleHistoryView;
else if (typeof document !== "undefined") document.addEventListener("DOMContentLoaded", () => {
  void StepsembleHistoryView.bootPreview(); void StepsembleHistoryView.bootHost();
}, { once: true });
