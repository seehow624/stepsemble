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
    subagents: ["May increase usage or cost. Native subagents inside this conversation follow the agent’s own rules and may also be affected.", "可能增加用量或费用。此对话内的原生子 Agent 依 Agent 自身规则，也可能受影响。", "可能增加用量或費用。此對話內的原生子 Agent 依 Agent 自身規則，也可能受影響。", "使用量や料金が増える場合があります。会話内のサブエージェントも独自の規則により影響を受ける場合があります。", "사용량이나 비용이 증가할 수 있습니다. 대화 내 하위 에이전트도 자체 규칙에 따라 영향을 받을 수 있습니다.", "Kullanım veya maliyet artabilir. Bu sohbetteki yerel alt ajanlar kendi kurallarına göre etkilenebilir.", "L’utilisation ou le coût peut augmenter. Les sous-agents natifs de cette conversation suivent leurs propres règles et peuvent aussi être affectés.", "Nutzung oder Kosten können steigen. Native Unteragenten dieser Unterhaltung können gemäß ihren eigenen Regeln ebenfalls betroffen sein.", "Puede aumentar el uso o coste. Los subagentes nativos de esta conversación siguen sus propias reglas y también pueden verse afectados.", "O uso ou custo pode aumentar. Subagentes nativos desta conversa seguem suas próprias regras e também podem ser afetados.", "Uso o costi possono aumentare. I sottoagenti nativi della conversazione seguono le proprie regole e possono esserne interessati."],
    unknown: ["Unknown", "未知", "未知", "不明", "알 수 없음", "Bilinmiyor", "Inconnu", "Unbekannt", "Desconocido", "Desconhecido", "Sconosciuto"],
    unavailable: ["Not available", "不提供", "不提供", "利用不可", "사용 불가", "Kullanılamıyor", "Indisponible", "Nicht verfügbar", "No disponible", "Indisponível", "Non disponibile"],
    gateway: ["Magpie forwards the requested tier; its global overrides or fallback may change it. Served tier is unknown.", "Magpie 转送所请求的 tier，但其全局覆盖或回退可能改变结果。实际 tier 未知。", "Magpie 轉送所請求的 tier，但其全域覆寫或回退可能改變結果。實際 tier 未知。", "Magpie は要求した tier を転送しますが、全体設定やフォールバックで変わる場合があります。実際の tier は不明です。", "Magpie가 요청한 tier를 전달하지만 전역 설정이나 폴백으로 달라질 수 있습니다. 실제 tier는 알 수 없습니다.", "Magpie istenen tier değerini iletir; genel ayarlar veya geri dönüş bunu değiştirebilir. Sunulan tier bilinmiyor.", "Magpie transmet le tier demandé ; ses réglages globaux ou son repli peuvent le modifier. Le tier servi est inconnu.", "Magpie leitet den gewünschten Tier weiter; globale Einstellungen oder Fallback können ihn ändern. Der tatsächlich bediente Tier ist unbekannt.", "Magpie reenvía el tier solicitado; sus ajustes globales o fallback pueden cambiarlo. El tier servido es desconocido.", "Magpie encaminha o tier solicitado; configurações globais ou fallback podem alterá-lo. O tier servido é desconhecido.", "Magpie inoltra il tier richiesto; impostazioni globali o fallback possono cambiarlo. Il tier servito è sconosciuto."],
    blocked: ["The agent, model or account does not currently offer Fast.", "Agent、模型或账户目前不提供 Fast。", "Agent、模型或帳戶目前不提供 Fast。", "エージェント、モデルまたはアカウントは現在 Fast を提供していません。", "에이전트, 모델 또는 계정에서 현재 Fast를 제공하지 않습니다.", "Ajan, model veya hesap şu anda Fast sunmuyor.", "L’agent, le modèle ou le compte ne propose pas Fast actuellement.", "Agent, Modell oder Konto bietet Fast derzeit nicht an.", "El agente, modelo o cuenta no ofrece Fast actualmente.", "O agente, modelo ou conta não oferece Fast no momento.", "L’agente, modello o account non offre Fast al momento."],
    reopen: ["Reopen this conversation to verify speed before sending.", "发送前请重新打开此对话以验证速度。", "送出前請重新開啟此對話以驗證速度。", "送信前に会話を開き直して速度を確認してください。", "보내기 전에 대화를 다시 열어 속도를 확인하세요.", "Göndermeden önce hızı doğrulamak için sohbeti yeniden açın.", "Rouvrez cette conversation pour vérifier la vitesse avant l’envoi.", "Öffne die Unterhaltung erneut, um vor dem Senden die Geschwindigkeit zu prüfen.", "Reabre esta conversación para verificar la velocidad antes de enviar.", "Reabra esta conversa para verificar a velocidade antes de enviar.", "Riapri questa conversazione per verificare la velocità prima di inviare."],
    unverified: ["This connection has not verified speed control. Existing agent settings may still apply.", "此连接尚未验证速度控制，Agent 原有设置可能仍适用。", "此連線尚未驗證速度控制，Agent 原有設定可能仍適用。", "この接続の速度制御は未確認です。既存の設定が適用される場合があります。", "이 연결의 속도 제어는 확인되지 않았습니다. 기존 설정이 적용될 수 있습니다.", "Bu bağlantının hız kontrolü doğrulanmadı. Mevcut ayarlar geçerli olabilir.", "Le contrôle de vitesse n’est pas vérifié. Les réglages existants peuvent s’appliquer.", "Die Geschwindigkeitssteuerung ist nicht bestätigt. Bestehende Einstellungen können gelten.", "El control de velocidad no está verificado. Pueden aplicarse los ajustes existentes.", "O controle de velocidade não foi verificado. As configurações existentes podem valer.", "Il controllo della velocità non è verificato. Le impostazioni esistenti possono applicarsi."],
    next: ["Preference for the next message. Provider speed is not confirmed; queued messages keep their own choice.", "下条消息的偏好。供应商实际速度尚未确认；排队消息保留各自选择。", "下則訊息的偏好。供應商實際速度尚未確認；排隊訊息保留各自選擇。", "次のメッセージの設定です。実際の速度は未確認です。待機中のメッセージは各設定を保持します。", "다음 메시지의 설정입니다. 실제 속도는 확인되지 않았으며 대기 메시지는 각 설정을 유지합니다.", "Sonraki mesajın tercihi. Sağlayıcı hızı doğrulanmadı; kuyruktaki mesajlar seçimlerini korur.", "Préférence du prochain message. Vitesse réelle non confirmée ; les messages en attente gardent leur choix.", "Wunsch für die nächste Nachricht. Tatsächliche Geschwindigkeit unbestätigt; wartende Nachrichten behalten ihre Wahl.", "Preferencia del próximo mensaje. Velocidad real sin confirmar; los mensajes en cola conservan su elección.", "Preferência da próxima mensagem. Velocidade real não confirmada; mensagens na fila mantêm sua escolha.", "Preferenza per il prossimo messaggio. Velocità effettiva non confermata; i messaggi in coda mantengono la scelta."],
    confirm: ["Enable Fast for this conversation? It may cost more. Reasoning stays unchanged.", "为此对话启用 Fast？可能产生额外费用，思考强度不变。", "為此對話啟用 Fast？可能產生額外費用，思考強度不變。", "この会話で Fast を有効にしますか？追加料金がかかる場合があります。推論強度は変わりません。", "이 대화에서 Fast를 켤까요? 추가 비용이 발생할 수 있으며 추론 강도는 바뀌지 않습니다.", "Bu sohbette Fast açılsın mı? Ek ücret olabilir. Akıl yürütme değişmez.", "Activer Fast pour cette conversation ? Des frais supplémentaires sont possibles. Le raisonnement reste inchangé.", "Fast für diese Unterhaltung aktivieren? Zusätzliche Kosten sind möglich. Die Denkleistung bleibt unverändert.", "¿Activar Fast para esta conversación? Puede costar más. El razonamiento no cambia.", "Ativar Fast nesta conversa? Pode custar mais. O raciocínio não muda.", "Attivare Fast per questa conversazione? Potrebbe costare di più. Il ragionamento non cambia."],
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
  function create({ root, indicator, button, description, context, get, post, locale = () => "en", confirm = text => window.confirm(text), onError = () => {} }) {
    let key = null, state = null, generation = 0, pending = null, pendingKey = null, saving = null, savingKey = null;
    const label = document.createElement("label"), select = document.createElement("select"), note = document.createElement("p");
    label.id = "agent-speed-label"; select.id = "agent-speed-select";
    select.hidden = true; select.tabIndex = -1; select.setAttribute("aria-hidden", "true");
    note.id = "agent-speed-note";
    const group = document.createElement("div"), details = document.createElement("details"), summary = document.createElement("summary"), status = document.createElement("span");
    group.className = "speed-options"; group.setAttribute("role", "radiogroup"); group.setAttribute("aria-labelledby", label.id);
    details.className = "speed-details"; summary.className = "speed-info"; summary.textContent = "i";
    status.className = "speed-status"; status.setAttribute("role", "status");
    details.append(summary, note); root.append(label, select, group, details, status);
    const controls = new Map();
    function addChoice(value) {
      const option = document.createElement("option"), choice = document.createElement("button");
      option.value = value; select.append(option);
      choice.type = "button"; choice.className = "speed-choice"; choice.setAttribute("role", "radio"); choice.setAttribute("data-speed", value);
      choice.addEventListener("click", () => {
        if (choice.disabled || choice.getAttribute("aria-disabled") === "true") return;
        select.value = value; void change();
      });
      choice.addEventListener("keydown", event => {
        const direction = ["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 0;
        if (!direction && !["Home", "End"].includes(event.key)) return;
        event.preventDefault();
        if (choice.getAttribute("aria-disabled") === "true") return;
        const enabled = [...controls.values()].filter(row => !row.choice.hidden && !row.choice.disabled);
        const index = enabled.findIndex(row => row.choice === choice);
        const next = enabled[event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1 : (index + direction + enabled.length) % enabled.length];
        next?.choice.focus(); if (next) { select.value = next.option.value; void change(); }
      });
      group.append(choice); controls.set(value, { option, choice });
    }
    addChoice("standard"); addChoice("fast");
    function render({ committed = false } = {}) {
      const language = locale(), current = (context()?.key || null) === key;
      const shown = current ? state : null;
      label.textContent = t("title", language);
      if (offered(shown, "ultrafast")) { if (!controls.has("ultrafast")) addChoice("ultrafast"); }
      else if (controls.has("ultrafast")) {
        const row = controls.get("ultrafast"); row.choice.remove(); row.option.remove(); controls.delete("ultrafast");
      }
      for (const [speed, row] of controls) {
        const text = speed === "fast" ? "Fast" : t(speed, language);
        if (row.option.textContent !== text) row.option.textContent = text;
        row.option.disabled = paid(speed) && !offered(shown, speed);
        row.choice.textContent = text;
        row.choice.hidden = paid(speed) && !offered(shown, speed);
      }
      const value = shown?.requested || "standard";
      if (select.value !== value && (committed || document.activeElement !== select || saving && savingKey === key || shown?.support !== "supported")) select.value = value;
      // A background GET must not close a native picker on window focus.
      // POST still revalidates the cached revision, fingerprint and support.
      const busy = !!saving && savingKey === key;
      const unavailable = shown?.support !== "supported" && !shown?.controlVerified && !paid(shown?.requested);
      const disabled = busy || unavailable;
      if (select.disabled !== disabled) select.disabled = disabled;
      group.setAttribute("aria-busy", String(busy));
      const selected = controls.get(value);
      const focusValue = selected && !selected.choice.hidden && !selected.option.disabled ? value : "standard";
      for (const [speed, row] of controls) {
        // Native disabled blurs the active radio during a delayed save. Keep
        // its focus ownership; aria-disabled plus activation guards block repeats.
        row.choice.disabled = unavailable || row.option.disabled;
        row.choice.setAttribute("aria-disabled", String(disabled || row.option.disabled));
        row.choice.setAttribute("aria-checked", String(speed === value));
        row.choice.tabIndex = speed === focusValue ? 0 : -1;
      }
      summary.setAttribute("aria-label", t("info", language)); summary.title = t("info", language);
      status.textContent = shown?.reason === "speed_load_failed" ? t("unknown", language) : shown?.effective === "cooldown" ? t("cooldown", language) : "";
      status.hidden = !status.textContent;
      const effective = ["standard", "fast", "ultrafast", "cooldown"].includes(shown?.effective) ? shown.effective : "unknown";
      note.textContent = (shown?.support === "supported" ? "" : t(shown?.support === "unavailable" ? "unavailable" : "unknown", language) + " · ")
        + t(reasonLabel(shown), language)
        + " · " + t("effective", language) + ": " + t(effective, language)
        + (shown?.route === "magpie" ? " · " + t("gateway", language) : "");
      const fast = paid(shown?.requested);
      if (indicator) { indicator.toggleAttribute("hidden", !fast); indicator.setAttribute("data-speed", shown?.requested || "standard"); }
      const requested = t("requested", language).replace("Fast", shown?.requested === "ultrafast" ? "Ultra Fast" : "Fast");
      const explanation = t("title", language) + (fast ? ": " + requested : "") + ". " + note.textContent;
      if (description) description.textContent = explanation;
      if (button) button.title = [button.getAttribute("aria-label"), explanation].filter(Boolean).join(". ");
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
        if (paid(speed) && !await confirm(t("confirm", locale()).replace("Fast", speed === "ultrafast" ? "Ultra Fast" : "Fast") + "\n\n" + t("subagents", locale()))) return;
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
    return Object.freeze({ sync, refresh, async ready() { if (saving && savingKey === context()?.key) await saving; await sync(); if (pending && pendingKey === context()?.key) await pending; },
      snapshot() { return context()?.key === key ? { speed: state?.requested || "standard", speedFingerprint: state?.preferenceFingerprint || null } : { speed: "standard" }; } });
  }
  return Object.freeze({ create, t, locales, copy });
});
