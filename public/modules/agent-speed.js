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
    failed: ["Speed was not saved. Reloaded the Host’s preference.", "速度未保存，已重新读取 Host 偏好。", "速度未儲存，已重新讀取 Host 偏好。", "速度を保存できませんでした。Host の設定を再読込しました。", "속도를 저장하지 못했습니다. Host 설정을 다시 읽었습니다.", "Hız kaydedilmedi. Host tercihi yeniden okundu.", "Vitesse non enregistrée. Préférence de l’hôte rechargée.", "Geschwindigkeit nicht gespeichert. Host-Einstellung neu geladen.", "Velocidad no guardada. Preferencia del Host recargada.", "Velocidade não salva. Preferência do Host recarregada.", "Velocità non salvata. Preferenza dell’Host ricaricata."]
  };
  const t = (key, locale = "en") => copy[key]?.[Math.max(0, locales.indexOf(locale))] || key;
  function create({ root, chip, context, get, post, locale = () => "en", confirm = text => window.confirm(text), onError = () => {} }) {
    let key = null, state = null, generation = 0, pending = null, saving = null;
    const label = document.createElement("label"), select = document.createElement("select"), note = document.createElement("p");
    label.htmlFor = "agent-speed-select"; select.id = "agent-speed-select";
    note.id = "agent-speed-note"; note.setAttribute("role", "status");
    select.setAttribute("aria-describedby", note.id);
    for (const value of ["standard", "fast"]) { const option = document.createElement("option"); option.value = value; select.append(option); }
    root.append(label, select, note);
    function render() {
      const language = locale();
      label.textContent = t("title", language);
      for (const option of select.options) {
        const text = t(option.value, language);
        if (option.textContent !== text) option.textContent = text;
        option.disabled = option.value === "fast" && state?.support !== "supported";
      }
      select.value = state?.requested || "standard";
      select.disabled = !!pending || state?.support !== "supported" && !state?.controlVerified && state?.requested !== "fast";
      const effective = ["standard", "fast", "cooldown"].includes(state?.effective) ? state.effective : "unknown";
      note.textContent = t(state?.reason === "speed_reopen_required" ? "reopen" : state?.support === "supported" ? "next" : state?.support === "unavailable" ? "blocked" : "unverified", language)
        + " · " + t("effective", language) + ": " + t(effective, language)
        + (state?.route === "magpie" ? " · " + t("gateway", language) : "");
      const status = state?.support === "supported" ? t(state.requested, language) : t(state?.support === "unavailable" ? "unavailable" : "unknown", language);
      if (chip) {
        const text = t("title", language) + ": " + status;
        if (chip.textContent !== text) chip.textContent = text;
        chip.title = note.textContent;
        chip.disabled = !context();
      }
    }
    async function refresh() {
      const target = context();
      if (saving && target?.key === key) return saving;
      const current = ++generation;
      if (key !== (target?.key || null)) state = null;
      key = target?.key || null;
      const promise = (async () => {
        if (target) {
          const { key: ignored, ...params } = target;
          try {
            const result = await get("/api/agent-speed?" + new URLSearchParams(params));
            if (current === generation && context()?.key === key) state = result;
          } catch { if (current === generation) state = null; }
        }
      })();
      pending = promise; render();
      await promise;
      if (current === generation) { pending = null; render(); }
    }
    function sync() {
      if ((context()?.key || null) !== key) return refresh();
      render();
    }
    select.addEventListener("change", async () => {
      const speed = select.value, target = context(), previous = state;
      if (!target || !previous || pending) return;
      if (speed === "fast" && !await confirm(t("confirm", locale()) + "\n\n" + t("subagents", locale()))) { render(); return; }
      if (context()?.key !== target.key) return;
      const current = ++generation;
      let failed = false;
      const operation = (async () => {
        try {
          const { key: ignored, ...params } = target;
          const result = await post("/api/agent-speed", { ...params, speed, confirmCost: speed === "fast", revision: previous.revision, fingerprint: previous.fingerprint });
          if (current === generation && context()?.key === target.key) state = result;
        } catch {
          if (current === generation) { failed = true; onError(t("failed", locale())); }
        }
      })();
      saving = operation; pending = operation; render();
      await operation;
      if (saving === operation) saving = null;
      if (current === generation) {
        pending = null;
        if (failed) await refresh(); else render();
      }
    });
    render();
    return Object.freeze({ sync, refresh, async ready() { if (saving) await saving; await sync(); if (pending) await pending; },
      snapshot() { return context()?.key === key ? { speed: state?.requested || "standard", speedFingerprint: state?.preferenceFingerprint || null } : { speed: "standard" }; } });
  }
  return Object.freeze({ create, t, locales, copy });
});
