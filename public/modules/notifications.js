/* Shared notification copy and the macOS permission bridge. No conversation content. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StepsembleNotifications = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";
  const keys = ["completed", "failed", "stopped", "approval", "test", "title", "note", "when", "enable", "on", "off", "blocked", "settings", "sendTest", "sent", "unavailable", "error", "blockedGoal", "checking", "retry", "reopen", "restartNote"];
  const copy = {
    en: ["Work completed", "Work failed", "Work stopped", "Approval needed", "Notifications are ready", "Notifications", "Completions, errors and requests for approval", "Applies to this device and the selected Host. Alerts stay quiet while you are viewing the session. Click an alert to return to it.", "Enable", "Notifications on", "Notifications off", "Notifications blocked", "Open notification settings", "Send test notification", "Test notification sent", "Not available", "Could not update notifications. Try again.", "Work needs your attention"],
    "zh-Hant": ["工作已完成", "工作失敗", "工作已停止", "需要你的核准", "通知已準備就緒", "通知", "工作完成、錯誤及需要核准時提醒", "套用於這台裝置與目前選擇的 Host。正在查看該 Session 時不打擾；點擊通知即可回到工作。", "啟用", "通知已開啟", "通知已關閉", "通知被封鎖", "打開通知設定", "發送測試通知", "測試通知已發送", "無法使用", "無法更新通知，請再試一次。", "工作需要你的處理"],
    "zh-Hans": ["工作已完成", "工作失败", "工作已停止", "需要你的批准", "通知已准备就绪", "通知", "工作完成、错误及需要批准时提醒", "应用于这台设备与当前选择的 Host。正在查看该 Session 时不打扰；点击通知即可回到工作。", "启用", "通知已开启", "通知已关闭", "通知被屏蔽", "打开通知设置", "发送测试通知", "测试通知已发送", "不可用", "无法更新通知，请重试。", "工作需要你的处理"],
    ja: ["作業が完了しました", "作業に失敗しました", "作業が停止しました", "承認が必要です", "通知の準備ができました", "通知", "完了、エラー、承認のリクエストを通知", "この端末と選択したホストに適用します。セッションを表示中は通知せず、通知をクリックすると作業に戻れます。", "有効にする", "通知オン", "通知オフ", "通知がブロックされています", "通知設定を開く", "テスト通知を送信", "テスト通知を送信しました", "利用できません", "通知を更新できません。再試行してください。", "作業への対応が必要です"],
    ko: ["작업 완료", "작업 실패", "작업 중지", "승인 필요", "알림 준비 완료", "알림", "완료, 오류 및 승인 요청 알림", "이 기기와 선택한 호스트에 적용됩니다. 세션을 보는 동안은 알리지 않습니다. 알림을 누르면 작업으로 돌아갑니다.", "사용", "알림 켜짐", "알림 꺼짐", "알림 차단됨", "알림 설정 열기", "테스트 알림 보내기", "테스트 알림 전송됨", "사용 불가", "알림을 변경할 수 없습니다. 다시 시도하세요.", "작업 확인 필요"],
    tr: ["İş tamamlandı", "İş başarısız", "İş durduruldu", "Onay gerekiyor", "Bildirimler hazır", "Bildirimler", "Tamamlanma, hata ve onay istekleri", "Bu cihaz ve seçili bilgisayar için geçerlidir. Oturumu izlerken bildirim gelmez. Bildirime tıklayarak işe dönün.", "Etkinleştir", "Bildirimler açık", "Bildirimler kapalı", "Bildirimler engellendi", "Bildirim ayarlarını aç", "Test bildirimi gönder", "Test bildirimi gönderildi", "Kullanılamıyor", "Bildirimler güncellenemedi. Tekrar deneyin.", "İş için müdahale gerekiyor"],
    fr: ["Travail terminé", "Échec du travail", "Travail arrêté", "Approbation requise", "Les notifications sont prêtes", "Notifications", "Fin du travail, erreurs et demandes d’approbation", "Pour cet appareil et l’hôte sélectionné. Aucune alerte pendant la consultation de la session. Cliquez sur une alerte pour revenir au travail.", "Activer", "Notifications activées", "Notifications désactivées", "Notifications bloquées", "Ouvrir les réglages de notification", "Envoyer une notification de test", "Notification de test envoyée", "Indisponible", "Impossible de modifier les notifications. Réessayez.", "Le travail nécessite votre attention"],
    de: ["Arbeit abgeschlossen", "Arbeit fehlgeschlagen", "Arbeit angehalten", "Genehmigung erforderlich", "Benachrichtigungen sind bereit", "Benachrichtigungen", "Abschluss, Fehler und Genehmigungsanfragen", "Für dieses Gerät und den ausgewählten Host. Beim Betrachten der Sitzung bleiben Meldungen stumm. Klicken Sie auf eine Meldung, um zur Arbeit zurückzukehren.", "Aktivieren", "Benachrichtigungen an", "Benachrichtigungen aus", "Benachrichtigungen blockiert", "Benachrichtigungseinstellungen öffnen", "Testbenachrichtigung senden", "Testbenachrichtigung gesendet", "Nicht verfügbar", "Benachrichtigungen konnten nicht geändert werden. Erneut versuchen.", "Arbeit erfordert Ihre Aufmerksamkeit"],
    es: ["Trabajo completado", "El trabajo falló", "Trabajo detenido", "Se necesita aprobación", "Las notificaciones están listas", "Notificaciones", "Finalización, errores y solicitudes de aprobación", "Para este dispositivo y el Host seleccionado. Sin alertas mientras consultas la sesión. Pulsa una alerta para volver al trabajo.", "Activar", "Notificaciones activadas", "Notificaciones desactivadas", "Notificaciones bloqueadas", "Abrir ajustes de notificaciones", "Enviar notificación de prueba", "Notificación de prueba enviada", "No disponible", "No se pudieron cambiar las notificaciones. Inténtalo de nuevo.", "El trabajo necesita tu atención"],
    "pt-BR": ["Trabalho concluído", "O trabalho falhou", "Trabalho interrompido", "Aprovação necessária", "As notificações estão prontas", "Notificações", "Conclusões, erros e pedidos de aprovação", "Para este dispositivo e o Host selecionado. Sem alertas enquanto vê a sessão. Clique num alerta para voltar ao trabalho.", "Ativar", "Notificações ativadas", "Notificações desativadas", "Notificações bloqueadas", "Abrir definições de notificações", "Enviar notificação de teste", "Notificação de teste enviada", "Indisponível", "Não foi possível alterar as notificações. Tente novamente.", "O trabalho precisa da sua atenção"],
    it: ["Lavoro completato", "Lavoro non riuscito", "Lavoro interrotto", "Approvazione richiesta", "Le notifiche sono pronte", "Notifiche", "Completamenti, errori e richieste di approvazione", "Per questo dispositivo e l’Host selezionato. Nessun avviso mentre guardi la sessione. Fai clic su un avviso per tornare al lavoro.", "Attiva", "Notifiche attive", "Notifiche disattivate", "Notifiche bloccate", "Apri impostazioni notifiche", "Invia notifica di prova", "Notifica di prova inviata", "Non disponibile", "Impossibile modificare le notifiche. Riprova.", "Il lavoro richiede la tua attenzione"],
  };
  const updateCopy = {
    "en": [
      "Checking…",
      "Retry",
      "Reopen Stepsemble",
      "The App is still running an older version. Save your input, quit Stepsemble with ⌘Q, then open it again to finish the update. The Host keeps running."
    ],
    "zh-Hant": [
      "查詢中…",
      "重試",
      "重新開啟 Stepsemble",
      "App 仍在執行舊版本。請先儲存輸入內容，按 ⌘Q 結束 Stepsemble，再重新開啟以完成更新。背景 Host 會繼續運作。"
    ],
    "zh-Hans": [
      "查询中…",
      "重试",
      "重新打开 Stepsemble",
      "App 仍在运行旧版本。请先保存输入内容，按 ⌘Q 退出 Stepsemble，再重新打开以完成更新。后台 Host 会继续运行。"
    ],
    "ja": [
      "確認中…",
      "再試行",
      "Stepsemble を開き直す",
      "古いバージョンのアプリが実行中です。入力を保存し、⌘Q で Stepsemble を終了してから開き直すと更新が完了します。ホストは動作を続けます。"
    ],
    "ko": [
      "확인 중…",
      "다시 시도",
      "Stepsemble 다시 열기",
      "앱이 이전 버전으로 실행 중입니다. 입력을 저장하고 ⌘Q로 Stepsemble을 종료한 후 다시 열어 업데이트를 완료하세요. 호스트는 계속 실행됩니다."
    ],
    "tr": [
      "Kontrol ediliyor…",
      "Tekrar dene",
      "Stepsemble’ı yeniden aç",
      "Uygulamanın eski sürümü çalışıyor. Girdinizi kaydedin, ⌘Q ile Stepsemble’dan çıkın ve güncellemeyi tamamlamak için yeniden açın. Host çalışmaya devam eder."
    ],
    "fr": [
      "Vérification…",
      "Réessayer",
      "Rouvrir Stepsemble",
      "L’app utilise encore une ancienne version. Enregistrez votre saisie, quittez Stepsemble avec ⌘Q puis rouvrez-le pour terminer la mise à jour. L’hôte reste actif."
    ],
    "de": [
      "Wird geprüft…",
      "Erneut versuchen",
      "Stepsemble neu öffnen",
      "Die App verwendet noch eine ältere Version. Speichern Sie Ihre Eingabe, beenden Sie Stepsemble mit ⌘Q und öffnen Sie es erneut, um das Update abzuschließen. Der Host läuft weiter."
    ],
    "es": [
      "Comprobando…",
      "Reintentar",
      "Volver a abrir Stepsemble",
      "La app sigue ejecutando una versión anterior. Guarda lo que has escrito, sal de Stepsemble con ⌘Q y vuelve a abrirlo para completar la actualización. El Host seguirá funcionando."
    ],
    "pt-BR": [
      "Verificando…",
      "Tentar novamente",
      "Reabrir Stepsemble",
      "O app ainda está executando uma versão anterior. Salve sua entrada, saia do Stepsemble com ⌘Q e abra-o novamente para concluir a atualização. O Host continua funcionando."
    ],
    "it": [
      "Verifica…",
      "Riprova",
      "Riapri Stepsemble",
      "L’app sta ancora usando una versione precedente. Salva ciò che hai scritto, chiudi Stepsemble con ⌘Q e riaprilo per completare l’aggiornamento. L’Host resta attivo."
    ]
  };
  for (const locale of Object.keys(copy)) copy[locale].push(...updateCopy[locale]);
  const t = (key, locale = "en") => (copy[locale === "pt" ? "pt-BR" : locale] || copy.en)[keys.indexOf(key)] || key;
  const native = () => !!globalThis.window?.webkit?.messageHandlers?.stepsemble;
  const nativeVersion = () => globalThis.navigator?.userAgent?.match(/\bStepsemble\/(\d+\.\d+\.\d+)(?=[\s;)]|$)/)?.[1] || null;
  function needsRestart(expected) {
    if (!native()) return false;
    const running = nativeVersion(), version = /^\d+\.\d+\.\d+$/.test(expected) ? expected : null;
    if (!running) return true;
    if (!version) return false;
    const a = running.split(".").map(Number), b = version.split(".").map(Number);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
    return false;
  }
  // The bridge was added in 3.8.42. A newer page can still use a compatible
  // older App while explaining that reopening finishes the App update.
  const supportsNativeNotifications = () => native() && !needsRestart("3.8.42");
  let sequence = 0;
  const pending = new Map();
  if (globalThis.window?.addEventListener) window.addEventListener("message", event => {
    if (event.origin !== location.origin || (event.source !== window && event.source !== window.parent) || event.data?.type !== "stepsemble-native-notifications") return;
    const request = pending.get(event.data.requestId);
    if (!request) return;
    pending.delete(event.data.requestId); clearTimeout(request.timer); request.resolve(event.data.result);
  });
  function request(action, host, locale) {
    return new Promise((resolve, reject) => {
      if (!native()) { reject(new Error(t("unavailable", locale))); return; }
      const requestId = "notice-" + (++sequence) + "-" + Date.now();
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(t("error", locale))); }, action === "enable" ? 120000 : 8000);
      pending.set(requestId, { resolve, timer });
      try { window.webkit.messageHandlers.stepsemble.postMessage({ type: "notifications", action, host, locale, requestId }); }
      catch (error) { pending.delete(requestId); clearTimeout(timer); reject(error); }
    });
  }
  function target(notice) {
    return notice && typeof notice.host === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(notice.host)
      && typeof notice.key === "string" && /^[a-f0-9-]{36}$/i.test(notice.key);
  }
  function href(notice) {
    return target(notice) ? "/workspace.html?host=" + encodeURIComponent(notice.host) + "&entry=" + encodeURIComponent(notice.key) : "/workspace.html";
  }
  return { t, copy, keys, native, nativeVersion, needsRestart, supportsNativeNotifications, request, target, href };
});
