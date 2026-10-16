/* Subagent chrome only. Agent names, tasks and results stay as the agent wrote them. */
(function(root,factory){
  const api=factory();
  if(typeof module==="object"&&module.exports)module.exports=api;
  else root.StepsembleSubagentI18n=api;
})(typeof window!=="undefined"?window:globalThis,function(){
  "use strict";
  const locales=["en","zh-Hans","zh-Hant","ja","ko","tr","fr","de","es","pt-BR","it"];
  const copy={
    "runningOne": ["1 subagent working", "1 个 subagent 执行中", "1 個 subagent 執行中", "1 件の subagent が作業中", "subagent 1개 작업 중", "1 subagent çalışıyor", "1 subagent au travail", "1 Subagent arbeitet", "1 subagent trabajando", "1 subagent trabalhando", "1 subagent al lavoro"],
    "runningMany": ["{count} subagents working", "{count} 个 subagent 执行中", "{count} 個 subagent 執行中", "{count} 件の subagent が作業中", "subagent {count}개 작업 중", "{count} subagent çalışıyor", "{count} subagents au travail", "{count} Subagents arbeiten", "{count} subagents trabajando", "{count} subagents trabalhando", "{count} subagent al lavoro"],
    "doneOne": ["1 subagent finished", "1 个 subagent 已完成", "1 個 subagent 已完成", "1 件の subagent が完了", "subagent 1개 완료", "1 subagent bitti", "1 subagent terminé", "1 Subagent fertig", "1 subagent terminado", "1 subagent concluído", "1 subagent completato"],
    "doneMany": ["{count} subagents finished", "{count} 个 subagent 已完成", "{count} 個 subagent 已完成", "{count} 件の subagent が完了", "subagent {count}개 완료", "{count} subagent bitti", "{count} subagents terminés", "{count} Subagents fertig", "{count} subagents terminados", "{count} subagents concluídos", "{count} subagent completati"],
    "failedPart": ["{count} failed", "{count} 个失败", "{count} 個失敗", "{count} 件失敗", "{count}개 실패", "{count} başarısız", "{count} en échec", "{count} fehlgeschlagen", "{count} con error", "{count} com falha", "{count} non riusciti"],
    "listLabel": ["Subagents", "Subagent", "Subagent", "Subagent", "Subagent", "Subagent'lar", "Subagents", "Subagents", "Subagents", "Subagents", "Subagent"],
    "status_pending": ["Waiting", "等待中", "等待中", "待機中", "대기 중", "Bekliyor", "En attente", "Wartet", "En espera", "Aguardando", "In attesa"],
    "status_running": ["Working", "执行中", "執行中", "作業中", "작업 중", "Çalışıyor", "En cours", "Läuft", "Trabajando", "Trabalhando", "In corso"],
    "status_completed": ["Done", "完成", "完成", "完了", "완료", "Bitti", "Terminé", "Fertig", "Terminado", "Concluído", "Completato"],
    "status_failed": ["Failed", "失败", "失敗", "失敗", "실패", "Başarısız", "Échec", "Fehlgeschlagen", "Error", "Falhou", "Non riuscito"],
    "status_started": ["Started", "已启动", "已啟動", "開始済み", "시작됨", "Başlatıldı", "Démarré", "Gestartet", "Iniciado", "Iniciado", "Avviato"],
    "fromHistory": ["Shown from the saved conversation, which keeps only part of its work.", "来自已保存的对话，只保留了部分过程。", "來自已儲存的對話，只保留了部分過程。", "保存された会話から表示しています。過程の一部だけが残っています。", "저장된 대화에서 불러왔으며, 과정의 일부만 남아 있습니다.", "Kaydedilmiş konuşmadan gösteriliyor; çalışmasının yalnızca bir kısmı saklandı.", "Affiché depuis la conversation enregistrée, qui ne garde qu’une partie de son travail.", "Aus dem gespeicherten Gespräch, das nur einen Teil seiner Arbeit enthält.", "Desde la conversación guardada, que conserva solo parte de su trabajo.", "Da conversa salva, que guarda só parte do trabalho.", "Dalla conversazione salvata, che conserva solo parte del suo lavoro."],
    "background": ["Background", "后台执行", "背景執行", "バックグラウンド", "백그라운드", "Arka planda", "En arrière-plan", "Im Hintergrund", "En segundo plano", "Em segundo plano", "In background"],
    "task": ["Task", "任务", "任務", "タスク", "작업", "Görev", "Tâche", "Aufgabe", "Tarea", "Tarefa", "Attività"],
    "activity": ["Activity", "过程", "過程", "経過", "진행 내용", "Etkinlik", "Activité", "Verlauf", "Actividad", "Atividade", "Attività svolta"],
    "result": ["Result", "结果", "結果", "結果", "결과", "Sonuç", "Résultat", "Ergebnis", "Resultado", "Resultado", "Risultato"],
    "noActivity": ["No activity reported yet", "尚未回报任何过程", "尚未回報任何過程", "まだ経過の報告はありません", "아직 보고된 진행 내용이 없습니다", "Henüz etkinlik bildirilmedi", "Aucune activité signalée pour l’instant", "Noch kein Verlauf gemeldet", "Aún no se ha informado actividad", "Nenhuma atividade informada ainda", "Nessuna attività segnalata finora"],
    "noResult": ["No result yet", "尚无结果", "尚無結果", "まだ結果はありません", "아직 결과가 없습니다", "Henüz sonuç yok", "Pas encore de résultat", "Noch kein Ergebnis", "Aún no hay resultado", "Ainda sem resultado", "Nessun risultato per ora"],
    "close": ["Close", "关闭", "關閉", "閉じる", "닫기", "Kapat", "Fermer", "Schließen", "Cerrar", "Fechar", "Chiudi"],
    "loading": ["Loading…", "加载中…", "載入中…", "読み込み中…", "불러오는 중…", "Yükleniyor…", "Chargement…", "Wird geladen…", "Cargando…", "Carregando…", "Caricamento…"],
    "detailUnavailable": ["Its details could not be loaded.", "无法加载它的详细内容。", "無法載入它的詳細內容。", "詳細を読み込めませんでした。", "세부 정보를 불러올 수 없습니다.", "Ayrıntıları yüklenemedi.", "Impossible de charger ses détails.", "Die Details konnten nicht geladen werden.", "No se pudieron cargar sus detalles.", "Não foi possível carregar os detalhes.", "Impossibile caricare i dettagli."],
    "approvalUnavailable": ["It asked for an approval that Stepsemble cannot answer for a subagent yet.", "它请求了批准，但 Stepsemble 目前还无法替 subagent 回复。", "它請求了核准，但 Stepsemble 目前還無法替 subagent 回覆。", "承認を求めましたが、Stepsemble はまだ subagent の承認に応答できません。", "승인을 요청했지만 Stepsemble은 아직 subagent의 승인에 응답할 수 없습니다.", "Onay istedi, ancak Stepsemble henüz bir subagent adına yanıt veremiyor.", "Il a demandé une approbation à laquelle Stepsemble ne peut pas encore répondre pour un subagent.", "Er hat eine Freigabe angefordert, die Stepsemble für einen Subagent noch nicht beantworten kann.", "Pidió una aprobación que Stepsemble aún no puede responder para un subagent.", "Pediu uma aprovação que o Stepsemble ainda não consegue responder para um subagent.", "Ha chiesto un’approvazione a cui Stepsemble non può ancora rispondere per un subagent."],
    "model": ["Model", "模型", "模型", "モデル", "모델", "Model", "Modèle", "Modell", "Modelo", "Modelo", "Modello"],
    "details": ["Details", "详情", "詳情", "詳細", "세부 정보", "Ayrıntılar", "Détails", "Details", "Detalles", "Detalhes", "Dettagli"],
    "tokens": ["{count} tokens", "{count} Token", "{count} Token", "{count} トークン", "{count} 토큰", "{count} token", "{count} jetons", "{count} Tokens", "{count} tokens", "{count} tokens", "{count} token"]
  };
  const tables=Object.fromEntries(locales.map((locale,index)=>[locale,Object.fromEntries(Object.entries(copy).map(([key,values])=>[key,values[index]]))]));
  function t(key,vars={},locale="en"){
    const source=tables[locale]?.[key]??tables.en[key]??key;
    return source.replace(/\{(\w+)\}/g,(match,name)=>Object.prototype.hasOwnProperty.call(vars,name)?String(vars[name]):match);
  }
  return Object.freeze({locales:Object.freeze(locales),tables,t});
});
