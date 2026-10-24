/* Speed is independent of reasoning. Only the Host's runtime evidence enables Fast. */
(function(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StepsembleAgentSpeed = api;
})(typeof window !== "undefined" ? window : globalThis, function() {
  "use strict";
  const locales = ["en", "zh-Hans", "zh-Hant", "ja", "ko", "tr", "fr", "de", "es", "pt-BR", "it"];
  const copy = {
    title: ["Speed", "速度", "速度", "速度", "속도", "Hız", "Vitesse", "Geschwindigkeit", "Velocidad", "Velocidade", "Velocità"],
    standard: ["Standard", "一般", "一般", "標準", "일반", "Standart", "Standard", "Standard", "Estándar", "Padrão", "Standard"],
    fast: ["Fast · extra cost", "Fast · 额外费用", "Fast · 額外費用", "Fast · 追加料金", "Fast · 추가 비용", "Fast · ek ücret", "Fast · coût supplémentaire", "Fast · Zusatzkosten", "Fast · coste adicional", "Fast · custo extra", "Fast · costo aggiuntivo"],
    effective: ["Reported state", "回报状态", "回報狀態", "報告された状態", "보고된 상태", "Bildirilen durum", "État signalé", "Gemeldeter Zustand", "Estado informado", "Estado informado", "Stato riportato"],
    cooldown: ["Cooldown", "冷却中", "冷卻中", "クールダウン", "대기 중", "Soğuma", "Refroidissement", "Abklingzeit", "Enfriamiento", "Resfriamento", "Raffreddamento"],
    subagents: ["Native subagents the agent starts here follow its own rules and may also be affected.", "Agent 在此对话启动的原生子 Agent 依其自身规则，也可能受影响。", "Agent 在此對話啟動的原生子 Agent 依其自身規則，也可能受影響。", "この会話でエージェントが起動するネイティブのサブエージェントも、独自の規則により影響を受ける場合があります。", "이 대화에서 에이전트가 시작하는 네이티브 하위 에이전트도 자체 규칙에 따라 영향을 받을 수 있습니다.", "Ajanın burada başlattığı yerel alt ajanlar kendi kurallarına göre etkilenebilir.", "Les sous-agents natifs lancés ici suivent les règles de l’agent et peuvent aussi être affectés.", "Native Unteragenten, die der Agent hier startet, folgen dessen Regeln und können ebenfalls betroffen sein.", "Los subagentes nativos que el agente inicie aquí siguen sus propias reglas y también pueden verse afectados.", "Subagentes nativos que o agente iniciar aqui seguem as regras dele e também podem ser afetados.", "I sottoagenti nativi avviati qui seguono le regole dell’agente e possono esserne interessati."],
    unknown: ["Unknown", "未知", "未知", "不明", "알 수 없음", "Bilinmiyor", "Inconnu", "Unbekannt", "Desconocido", "Desconhecido", "Sconosciuto"],
    unavailable: ["Not available", "不提供", "不提供", "利用不可", "사용 불가", "Kullanılamıyor", "Indisponible", "Nicht verfügbar", "No disponible", "Indisponível", "Non disponibile"],
    gateway: ["Magpie forwards the requested tier; its global overrides or fallback may change it. Served tier is unknown.", "Magpie 转送所请求的 tier，但其全局覆盖或回退可能改变结果。实际 tier 未知。", "Magpie 轉送所請求的 tier，但其全域覆寫或回退可能改變結果。實際 tier 未知。", "Magpie は要求した tier を転送しますが、全体設定やフォールバックで変わる場合があります。実際の tier は不明です。", "Magpie가 요청한 tier를 전달하지만 전역 설정이나 폴백으로 달라질 수 있습니다. 실제 tier는 알 수 없습니다.", "Magpie istenen tier değerini iletir; genel ayarlar veya geri dönüş bunu değiştirebilir. Sunulan tier bilinmiyor.", "Magpie transmet le tier demandé ; ses réglages globaux ou son repli peuvent le modifier. Le tier servi est inconnu.", "Magpie leitet den gewünschten Tier weiter; globale Einstellungen oder Fallback können ihn ändern. Der tatsächlich bediente Tier ist unbekannt.", "Magpie reenvía el tier solicitado; sus ajustes globales o fallback pueden cambiarlo. El tier servido es desconocido.", "Magpie encaminha o tier solicitado; configurações globais ou fallback podem alterá-lo. O tier servido é desconhecido.", "Magpie inoltra il tier richiesto; impostazioni globali o fallback possono cambiarlo. Il tier servito è sconosciuto."],
    blocked: ["The agent, model or account does not currently offer Fast.", "Agent、模型或账户目前不提供 Fast。", "Agent、模型或帳戶目前不提供 Fast。", "エージェント、モデルまたはアカウントは現在 Fast を提供していません。", "에이전트, 모델 또는 계정에서 현재 Fast를 제공하지 않습니다.", "Ajan, model veya hesap şu anda Fast sunmuyor.", "L’agent, le modèle ou le compte ne propose pas Fast actuellement.", "Agent, Modell oder Konto bietet Fast derzeit nicht an.", "El agente, modelo o cuenta no ofrece Fast actualmente.", "O agente, modelo ou conta não oferece Fast no momento.", "L’agente, modello o account non offre Fast al momento."],
    reopen: ["Reopen this conversation to verify speed before sending.", "发送前请重新打开此对话以验证速度。", "送出前請重新開啟此對話以驗證速度。", "送信前に会話を開き直して速度を確認してください。", "보내기 전에 대화를 다시 열어 속도를 확인하세요.", "Göndermeden önce hızı doğrulamak için sohbeti yeniden açın.", "Rouvrez cette conversation pour vérifier la vitesse avant l’envoi.", "Öffne die Unterhaltung erneut, um vor dem Senden die Geschwindigkeit zu prüfen.", "Reabre esta conversación para verificar la velocidad antes de enviar.", "Reabra esta conversa para verificar a velocidade antes de enviar.", "Riapri questa conversazione per verificare la velocità prima di inviare."],
    unverified: ["This connection has not verified speed control. Existing agent settings may still apply.", "此连接尚未验证速度控制，Agent 原有设置可能仍适用。", "此連線尚未驗證速度控制，Agent 原有設定可能仍適用。", "この接続の速度制御は未確認です。既存の設定が適用される場合があります。", "이 연결의 속도 제어는 확인되지 않았습니다. 기존 설정이 적용될 수 있습니다.", "Bu bağlantının hız kontrolü doğrulanmadı. Mevcut ayarlar geçerli olabilir.", "Le contrôle de vitesse n’est pas vérifié. Les réglages existants peuvent s’appliquer.", "Die Geschwindigkeitssteuerung ist nicht bestätigt. Bestehende Einstellungen können gelten.", "El control de velocidad no está verificado. Pueden aplicarse los ajustes existentes.", "O controle de velocidade não foi verificado. As configurações existentes podem valer.", "Il controllo della velocità non è verificato. Le impostazioni esistenti possono applicarsi."],
    next: ["Preference for the next message. Provider speed is not confirmed; queued messages keep their own choice.", "下条消息的偏好。供应商实际速度尚未确认；排队消息保留各自选择。", "下則訊息的偏好。供應商實際速度尚未確認；排隊訊息保留各自選擇。", "次のメッセージの設定です。実際の速度は未確認です。待機中のメッセージは各設定を保持します。", "다음 메시지의 설정입니다. 실제 속도는 확인되지 않았으며 대기 메시지는 각 설정을 유지합니다.", "Sonraki mesajın tercihi. Sağlayıcı hızı doğrulanmadı; kuyruktaki mesajlar seçimlerini korur.", "Préférence du prochain message. Vitesse réelle non confirmée ; les messages en attente gardent leur choix.", "Wunsch für die nächste Nachricht. Tatsächliche Geschwindigkeit unbestätigt; wartende Nachrichten behalten ihre Wahl.", "Preferencia del próximo mensaje. Velocidad real sin confirmar; los mensajes en cola conservan su elección.", "Preferência da próxima mensagem. Velocidade real não confirmada; mensagens na fila mantêm sua escolha.", "Preferenza per il prossimo messaggio. Velocità effettiva non confermata; i messaggi in coda mantengono la scelta."],
    // {tier} is Fast or Ultra Fast, named as the providers name them.
    confirmTitle: ["Turn on {tier}?", "开启 {tier}？", "開啟 {tier}？", "{tier} をオンにしますか？", "{tier}를 켤까요?", "{tier} açılsın mı?", "Activer {tier} ?", "{tier} einschalten?", "¿Activar {tier}?", "Ativar {tier}?", "Attivare {tier}?"],
    confirmBody: ["Replies can arrive sooner but may use more of your plan or cost more. The model and reasoning stay the same.", "回复可能更快，但可能消耗更多额度或产生额外费用。模型与思考强度不变。", "回覆可能更快，但可能消耗更多額度或產生額外費用。模型與思考強度不變。", "応答が速くなる場合がありますが、利用枠の消費や料金が増える可能性があります。モデルと推論強度は変わりません。", "응답이 더 빨라질 수 있지만 사용량이나 비용이 늘 수 있습니다. 모델과 추론 강도는 그대로입니다.", "Yanıtlar daha hızlı gelebilir ancak daha fazla kullanım veya ücret gerektirebilir. Model ve akıl yürütme aynı kalır.", "Les réponses peuvent arriver plus vite, mais consommer davantage de votre forfait ou coûter plus. Le modèle et le raisonnement ne changent pas.", "Antworten können schneller kommen, aber mehr Kontingent verbrauchen oder mehr kosten. Modell und Denkleistung bleiben gleich.", "Las respuestas pueden llegar antes, pero usar más de tu plan o costar más. El modelo y el razonamiento no cambian.", "As respostas podem chegar mais rápido, mas usar mais do seu plano ou custar mais. O modelo e o raciocínio não mudam.", "Le risposte possono arrivare prima, ma consumare più del tuo piano o costare di più. Modello e ragionamento restano invariati."],
    confirmAction: ["Turn on {tier}", "开启 {tier}", "開啟 {tier}", "{tier} をオン", "{tier} 켜기", "{tier} aç", "Activer {tier}", "{tier} einschalten", "Activar {tier}", "Ativar {tier}", "Attiva {tier}"],
    cancel: ["Cancel", "取消", "取消", "キャンセル", "취소", "Vazgeç", "Annuler", "Abbrechen", "Cancelar", "Cancelar", "Annulla"],
    failed: ["Speed was not saved. Rechecking the Host’s preference.", "速度未保存，正在重新读取 Host 偏好。", "速度未儲存，正在重新讀取 Host 偏好。", "速度を保存できませんでした。Host の設定を再確認します。", "속도를 저장하지 못했습니다. Host 설정을 다시 확인합니다.", "Hız kaydedilmedi. Host tercihi yeniden kontrol ediliyor.", "Vitesse non enregistrée. Vérification de la préférence de l’hôte.", "Geschwindigkeit nicht gespeichert. Host-Einstellung wird erneut geprüft.", "Velocidad no guardada. Comprobando la preferencia del Host.", "Velocidade não salva. Verificando a preferência do Host.", "Velocità non salvata. Verifica della preferenza dell’Host."]
  };
  // Safe categories only: never echo runtime messages, provider URLs or credentials.
  const reasonCopy = {
    route: ["Native route contract is unverified.", "原生路由协议尚未验证。", "原生路由協議尚未驗證。", "ネイティブルートの契約は未確認です。", "네이티브 경로 계약이 확인되지 않았습니다.", "Yerel rota sözleşmesi doğrulanmadı.", "Contrat de route native non vérifié.", "Nativer Routenvertrag nicht bestätigt.", "Contrato de ruta nativa sin verificar.", "Contrato da rota nativa não verificado.", "Contratto della rotta nativa non verificato."],
    model: ["This model has no verified Fast offering in the native catalog.", "原生目录尚未确认此模型提供 Fast。", "原生目錄尚未確認此模型提供 Fast。", "ネイティブカタログでこのモデルの Fast は未確認です。", "네이티브 목록에서 이 모델의 Fast가 확인되지 않았습니다.", "Yerel katalogda bu model için Fast doğrulanmadı.", "Fast non vérifié pour ce modèle dans le catalogue natif.", "Fast für dieses Modell im nativen Katalog nicht bestätigt.", "Fast sin verificar para este modelo en el catálogo nativo.", "Fast não verificado para este modelo no catálogo nativo.", "Fast non verificato per questo modello nel catalogo nativo."],
    refused: ["The native runtime reports Fast is blocked by its account or usage policy.", "原生运行时报告账户或用量策略阻止 Fast。", "原生執行環境回報帳戶或用量政策阻止 Fast。", "アカウントまたは使用ポリシーにより Fast が拒否されています。", "계정 또는 사용 정책으로 Fast가 차단되었습니다.", "Yerel çalışma zamanı hesap veya kullanım ilkesi nedeniyle Fast'i engelliyor.", "Le runtime natif bloque Fast selon sa politique de compte ou d’usage.", "Die native Laufzeit blockiert Fast wegen Konto- oder Nutzungsrichtlinien.", "El runtime nativo bloquea Fast por su política de cuenta o uso.", "O runtime nativo bloqueia Fast por política de conta ou uso.", "Il runtime nativo blocca Fast per criteri di account o utilizzo."],
    loadFailed: ["Speed could not be verified. Reopen the model chooser to retry.", "无法验证速度，请重新打开模型选择器重试。", "無法驗證速度，請重新開啟模型選擇器重試。", "速度を確認できません。モデル選択を開き直してください。", "속도를 확인하지 못했습니다. 모델 선택기를 다시 여세요.", "Hız doğrulanamadı. Yeniden denemek için model seçiciyi açın.", "Vitesse non vérifiée. Rouvrez le sélecteur de modèle pour réessayer.", "Geschwindigkeit nicht bestätigt. Modellauswahl zum Wiederholen öffnen.", "No se pudo verificar la velocidad. Reabre el selector de modelo.", "Não foi possível verificar a velocidade. Reabra o seletor de modelo.", "Velocità non verificata. Riapri il selettore del modello."],
    inactive: ["The owning runtime is inactive or its conversation identity could not be verified.", "所属运行时未激活或无法验证对话身份。", "所屬執行環境未啟用或無法驗證對話身分。", "実行環境が未起動か会話の識別を確認できません。", "런타임이 비활성 상태이거나 대화 신원을 확인하지 못했습니다.", "Çalışma zamanı etkin değil veya sohbet kimliği doğrulanamadı.", "Runtime inactif ou identité de conversation non vérifiée.", "Laufzeit inaktiv oder Unterhaltungsidentität nicht bestätigt.", "Runtime inactivo o identidad de conversación sin verificar.", "Runtime inativo ou identidade da conversa não verificada.", "Runtime inattivo o identità della conversazione non verificata."],
    requested: ["Fast requested", "已请求 Fast", "已請求 Fast", "Fast を要求", "Fast 요청됨", "Fast istendi", "Fast demandé", "Fast angefordert", "Fast solicitado", "Fast solicitado", "Fast richiesto"]
  };
  Object.assign(copy, reasonCopy, {
    ultrafast: locales.map(() => "Ultra Fast"),
    info: ["Speed details", "速度详情", "速度資訊", "速度の詳細", "속도 정보", "Hız ayrıntıları", "Détails de vitesse", "Geschwindigkeitsdetails", "Detalles de velocidad", "Detalhes de velocidade", "Dettagli velocità"]
  });
  const paid = speed => speed === "fast" || speed === "ultrafast";
  // The tier's own name, as providers write it; the buttons' labels add its cost.
  const tierName = speed => speed === "ultrafast" ? "Ultra Fast" : "Fast";
  const offered = (state, speed) => state?.support === "supported" && (speed === "fast"
    ? (!state.choices || state.choices.includes(speed))
    : speed === "ultrafast" && state.route === "openai-native" && state.choices?.includes(speed)
      && state.tiers?.ultrafast === "ultrafast" && !!state.fingerprints?.ultrafast);
  const fingerprintFor = (state, speed) => speed === "ultrafast" ? state?.fingerprints?.ultrafast : state?.fingerprint;
  const t = (key, locale = "en") => copy[key]?.[Math.max(0, locales.indexOf(locale))] || key;
  function reasonLabel(state) {
    if (state?.support === "supported") return "next";
    const reason = state?.reason || "";
    if (reason === "speed_load_failed") return "loadFailed";
    if (reason === "speed_reopen_required") return "reopen";
    if (/inactive|thread_identity/.test(reason)) return "inactive";
    if (/route|contract|gateway/.test(reason)) return "route";
    if (/model|catalog|not_offered/.test(reason)) return "model";
    if (state?.support === "unavailable") return "refused";
    return "unverified";
  }
  const BOLT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 10-13h-8l1-7Z"/>';
  const element = (tag, className, id) => { const node = document.createElement(tag); if (className) node.className = className; if (id) node.id = id; return node; };
  // panel: where the details and a paid tier's confirmation open, below the
  // heading the tiers sit in, so opening them never rearranges that heading.
  // confirm: replaces the in-place confirmation (tests); without a panel,
  // the browser's own dialog asks.
  function create({ root, panel = null, indicator, button, description, context, get, post, locale = () => "en", confirm: askCost = null, onError = () => {} }) {
    let key = null, state = null, generation = 0, pending = null, pendingKey = null, saving = null, savingKey = null;
    const label = element("label", "sr-only", "agent-speed-label"), select = element("select", "", "agent-speed-select");
    select.hidden = true; select.tabIndex = -1; select.setAttribute("aria-hidden", "true");
    const note = element("div", "speed-note", "agent-speed-note"), noteMain = element("p", "speed-note-main"), noteState = element("p", "speed-note-state"), noteGateway = element("p", "speed-note-gateway");
    note.hidden = true; note.append(noteMain, noteState, noteGateway);
    const group = element("div", "speed-options"), info = element("button", "speed-info"), status = element("span", "speed-status");
    group.setAttribute("role", "group"); group.setAttribute("aria-labelledby", label.id);
    info.type = "button"; info.setAttribute("aria-expanded", "false"); info.setAttribute("aria-controls", note.id);
    info.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.25"/><path d="M12 10.75v5.5"/><path class="speed-info-dot" d="M12 7.6h.01"/></svg>';
    status.setAttribute("role", "status");
    const ask = element("div", "speed-confirm", "agent-speed-confirm"), askTitle = element("p", "speed-confirm-title", "agent-speed-confirm-title"), askName = element("span");
    const askBody = element("p", "speed-confirm-body", "agent-speed-confirm-body"), askNote = element("p", "speed-confirm-note", "agent-speed-confirm-note"), askActions = element("div", "speed-confirm-actions");
    const askCancel = element("button", "btn ghost speed-confirm-cancel"), askOk = element("button", "btn primary speed-confirm-ok"), askIcon = element("span", "speed-confirm-icon");
    ask.hidden = true; ask.setAttribute("role", "alertdialog"); ask.setAttribute("aria-labelledby", askTitle.id); ask.setAttribute("aria-describedby", askBody.id + " " + askNote.id);
    // Safari's default Tab order skips plain buttons; these must stay reachable.
    askIcon.setAttribute("aria-hidden", "true"); askCancel.type = "button"; askOk.type = "button"; askCancel.tabIndex = 0; askOk.tabIndex = 0; info.tabIndex = 0;
    askTitle.append(askIcon, askName); askActions.append(askCancel, askOk); ask.append(askTitle, askBody, askNote, askActions);
    root.append(label, select, group, info, status); (panel || root).append(note, ask);
    function syncPanel() { if (panel) panel.hidden = root.hidden || note.hidden && ask.hidden; }
    function showInfo(open) { note.hidden = !open; info.setAttribute("aria-expanded", String(open)); syncPanel(); }
    info.addEventListener("click", () => { if (ask.hidden) showInfo(note.hidden); });
    // A paid tier is confirmed in place. Focus starts on Cancel, so a repeated
    // Enter never confirms a cost, and returns to the tier asked for.
    let asking = null;
    function settle(value) {
      if (!asking) return;
      const { resolve, trigger } = asking, inside = typeof ask.contains === "function" && ask.contains(document.activeElement);
      asking = null; ask.hidden = true; trigger?.removeAttribute?.("data-pending"); syncPanel();
      if (inside && trigger?.isConnected) trigger.focus({ preventScroll: true });
      resolve(value);
    }
    function confirmInPlace(tier, trigger) {
      settle(false);
      const language = locale(), name = tierName(tier);
      askIcon.innerHTML = BOLT + (tier === "ultrafast" ? '<path class="speed-plus" d="M19 2v6m-3-3h6"/>' : "") + "</svg>";
      askName.textContent = t("confirmTitle", language).replace("{tier}", name);
      askBody.textContent = t("confirmBody", language); askNote.textContent = t("subagents", language);
      askCancel.textContent = t("cancel", language); askOk.textContent = t("confirmAction", language).replace("{tier}", name);
      showInfo(false); ask.hidden = false; trigger?.setAttribute("data-pending", "true"); syncPanel();
      return new Promise(resolve => {
        asking = { resolve, trigger, key };
        askCancel.focus({ preventScroll: true }); ask.scrollIntoView?.({ block: "nearest" });
      });
    }
    askCancel.addEventListener("click", () => settle(false));
    askOk.addEventListener("click", () => settle(true));
    ask.addEventListener("keydown", event => { if (event.key !== "Escape") return; event.preventDefault(); event.stopPropagation(); settle(false); });
    function confirmCost(tier, trigger) {
      if (panel && !askCost) return confirmInPlace(tier, trigger);
      const text = [t("confirmTitle", locale()), t("confirmBody", locale()), t("subagents", locale())].join("\n\n").replace("{tier}", tierName(tier));
      if (askCost) return askCost(text, { tier });
      // Never the browser's dialog; without the app's own, the answer is no.
      return globalThis.StepsembleAppDialog?.confirm(text, { action: "enable" }) ?? Promise.resolve(false);
    }
    const controls = new Map();
    function addChoice(value) {
      const option = document.createElement("option"), choice = document.createElement("button");
      option.value = value; if (value !== "standard") select.append(option);
      choice.type = "button"; choice.className = "speed-choice"; choice.setAttribute("data-speed", value);
      choice.addEventListener("click", () => {
        if (choice.disabled || choice.getAttribute("aria-disabled") === "true") return;
        select.value = state?.requested === value ? "standard" : value; void change();
      });
      if (paid(value)) choice.innerHTML = BOLT + (value === "ultrafast" ? '<path class="speed-plus" d="M19 2v6m-3-3h6"/>' : '') + '</svg>';
      group.append(choice); controls.set(value, { option, choice });
    }
    // Standard remains the native record, but only appears as an off-only
    // recovery action when a saved paid tier is no longer offered.
    const standardOption = document.createElement("option"); standardOption.value = "standard"; select.append(standardOption);
    function render({ committed = false } = {}) {
      const language = locale(), current = (context()?.key || null) === key;
      const shown = current ? state : null;
      label.textContent = t("title", language);
      const value = shown?.requested || "standard";
      const recovery = paid(value) && !offered(shown, value);
      for (const speed of ["fast", "ultrafast", "standard"]) {
        const visible = speed === "standard" ? recovery : offered(shown, speed);
        if (visible && !controls.has(speed)) addChoice(speed);
        else if (!visible && controls.has(speed)) {
          const row = controls.get(speed); row.choice.remove(); if (speed !== "standard") row.option.remove(); controls.delete(speed);
        }
      }
      standardOption.textContent = t("standard", language);
      for (const [speed, row] of controls) {
        const text = t(speed, language);
        row.option.textContent = text;
        row.choice.setAttribute("aria-label", text);
        row.choice.setAttribute("aria-describedby", note.id);
        row.choice.title = text;
        if (speed === "standard") row.choice.textContent = text;
      }
      root.hidden = controls.size === 0;
      // A confirmation belongs to the conversation and tiers it was asked for.
      if (asking && (!current || asking.key !== key || root.hidden)) settle(false);
      if (root.hidden) showInfo(false); else syncPanel();
      if (select.value !== value && (committed || document.activeElement !== select || saving && savingKey === key || shown?.support !== "supported")) select.value = value;
      // A background GET must not close a native picker on window focus.
      // POST still revalidates the cached revision, fingerprint and support.
      const busy = !!saving && savingKey === key;
      const unavailable = shown?.support !== "supported" && !shown?.controlVerified && !paid(shown?.requested);
      const disabled = busy || unavailable;
      if (select.disabled !== disabled) select.disabled = disabled;
      group.setAttribute("aria-busy", String(busy));
      for (const [speed, row] of controls) {
        // Keep native focus during confirmation/save; guards prevent repeat
        // activation. Ordinary buttons use Tab/Enter/Space, never paid arrows.
        row.choice.setAttribute("aria-disabled", String(disabled));
        row.choice.setAttribute("aria-pressed", String(speed === value));
        row.choice.tabIndex = 0;
      }
      info.setAttribute("aria-label", t("info", language)); info.title = t("info", language);
      status.textContent = shown?.reason === "speed_load_failed" ? t("unknown", language) : shown?.effective === "cooldown" ? t("cooldown", language) : "";
      status.hidden = !status.textContent;
      const effective = ["standard", "fast", "ultrafast", "cooldown"].includes(shown?.effective) ? shown.effective : "unknown";
      const reason = (shown?.support === "supported" ? "" : t(shown?.support === "unavailable" ? "unavailable" : "unknown", language) + " · ") + t(reasonLabel(shown), language);
      const reported = t("effective", language) + ": " + t(effective, language), gateway = shown?.route === "magpie" ? t("gateway", language) : "";
      noteMain.textContent = reason; noteState.textContent = reported; noteGateway.textContent = gateway; noteGateway.hidden = !gateway;
      const noteText = [reason, reported, gateway].filter(Boolean).join(" · ");
      const fast = paid(shown?.requested);
      if (indicator) { indicator.toggleAttribute("hidden", !fast); indicator.setAttribute("data-speed", shown?.requested || "standard"); }
      const requested = t("requested", language).replace("Fast", shown?.requested === "ultrafast" ? "Ultra Fast" : "Fast");
      const explanation = t("title", language) + (fast ? ": " + requested : "") + ". " + noteText;
      if (description) description.textContent = explanation;
    }
    async function refresh({ afterPending = false } = {}) {
      const target = context(), targetKey = target?.key || null;
      if (saving && targetKey === savingKey) return saving;
      if (pending && targetKey === pendingKey && targetKey === key) {
        if (!afterPending) return pending;
        await pending;
        if ((context()?.key || null) === targetKey) return refresh();
        return;
      }
      const current = ++generation;
      if (key !== targetKey) state = null;
      key = targetKey;
      const promise = (async () => {
        if (target) {
          const { key: ignored, ...params } = target;
          try {
            const result = await get("/api/agent-speed?" + new URLSearchParams(params));
            if (current === generation && context()?.key === targetKey) state = result;
          } catch {
            if (current === generation && context()?.key === targetKey) {
              state = { requested: state?.requested || "standard", support: "unknown", effective: "unknown", reason: "speed_load_failed", revision: state?.revision };
              onError(t("loadFailed", locale()));
            }
          }
        }
      })();
      pending = promise; pendingKey = targetKey; render();
      await promise;
      if (pending === promise) { pending = null; pendingKey = null; }
      if (current === generation) render();
    }
    function sync() {
      if ((context()?.key || null) !== key) return refresh();
      render();
    }
    select.addEventListener("blur", () => { if (!saving || savingKey !== key) render({ committed: true }); });
    async function change() {
      const speed = select.value, target = context(), previous = state;
      if (!target || target.key !== key || !previous || saving && savingKey === target.key || paid(speed) && !offered(previous, speed)) { render({ committed: true }); return; }
      if (speed === previous.requested) { render({ committed: true }); return; }
      // Lock before confirmation: dismissing a native dialog may fire focus.
      const current = ++generation;
      let failed = false;
      const operation = Promise.resolve().then(async () => {
        if (paid(speed) && !await confirmCost(speed, controls.get(speed)?.choice)) return;
        if (current !== generation || context()?.key !== target.key) return;
        try {
          const { key: ignored, ...params } = target;
          const result = await post("/api/agent-speed", { ...params, speed, confirmCost: paid(speed), revision: previous.revision, fingerprint: fingerprintFor(previous, speed) });
          if (current === generation && context()?.key === target.key) state = result;
        } catch {
          if (current === generation && context()?.key === target.key) { failed = true; onError(t("failed", locale())); }
        }
      });
      saving = operation; savingKey = target.key; render();
      await operation;
      if (saving === operation) { saving = null; savingKey = null; }
      if (current === generation) {
        // A GET started before this save must not undo the new preference.
        pending = null; pendingKey = null;
        if (failed) await refresh(); else render({ committed: true });
      }
    }
    select.addEventListener("change", change);
    render();
    return Object.freeze({ sync, refresh,
      // The sheet that holds a pending confirmation is closing or asked to
      // step back: the paid tier is not confirmed. True when one was pending.
      cancelConfirmation() { if (!asking) return false; settle(false); return true; },
      async ready() { if (saving && savingKey === context()?.key) await saving; await sync(); if (pending && pendingKey === context()?.key) await pending; },
      snapshot() { return context()?.key === key ? { speed: state?.requested || "standard", speedFingerprint: state?.preferenceFingerprint || null } : { speed: "standard" }; } });
  }
  return Object.freeze({ create, t, locales, copy });
});
