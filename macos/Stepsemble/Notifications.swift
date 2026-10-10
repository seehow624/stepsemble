import AppKit
import WebKit
import UserNotifications

/// Polls lifecycle facts independently of workspace windows, so closing the
/// last window does not disconnect alerts. Permission is requested on Enable.
final class NativeNotifications: NSObject, UNUserNotificationCenterDelegate, URLSessionTaskDelegate {
    private let center = UNUserNotificationCenter.current()
    private let open: ([String: String]) -> Void
    private let visible: (String, String) -> Bool
    private var timer: Timer?
    private var polling = false
    private var cursors: [String: String] = [:]
    private var revisions: [String: Int] = [:]
    private var enabled: Set<String> { Set(UserDefaults.standard.stringArray(forKey: "notificationHosts") ?? []) }
    init(open: @escaping ([String: String]) -> Void, visible: @escaping (String, String) -> Bool) {
        self.open = open; self.visible = visible
        super.init(); center.delegate = self
    }
    func start() {
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.poll() }
        poll()
    }
    func request(_ action: String, host: String, locale: String, completion: @escaping ([String: Any]) -> Void) {
        if Text.tables[locale] != nil { UserDefaults.standard.set(locale, forKey: "notificationLocale") }
        let finish = { self.status(host, completion: completion) }
        switch action {
        case "enable":
            let revision = (revisions[host] ?? 0) + 1; revisions[host] = revision
            center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                DispatchQueue.main.async {
                    if granted && self.revisions[host] == revision { var hosts = self.enabled; hosts.insert(host); self.save(hosts); self.cursors.removeValue(forKey: host); self.poll() }
                    finish()
                }
            }
        case "disable":
            revisions[host] = (revisions[host] ?? 0) + 1
            var hosts = enabled; hosts.remove(host); save(hosts); cursors.removeValue(forKey: host); finish()
        case "settings":
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.notifications")!); finish()
        case "test":
            center.getNotificationSettings { settings in
                DispatchQueue.main.async {
                    if self.enabled.contains(host) && [.authorized, .provisional].contains(settings.authorizationStatus) {
                        self.show(["kind": "test", "host": host, "key": "test", "title": "Stepsemble"])
                    }
                    finish()
                }
            }
        default: finish()
        }
    }
    private func save(_ hosts: Set<String>) { UserDefaults.standard.set(Array(hosts).sorted(), forKey: "notificationHosts") }
    private func status(_ host: String, completion: @escaping ([String: Any]) -> Void) {
        center.getNotificationSettings { settings in
            DispatchQueue.main.async {
                let permission = settings.authorizationStatus == .denied ? "denied" : [.authorized, .provisional].contains(settings.authorizationStatus) ? "granted" : "default"
                completion(["permission": permission, "enabled": self.enabled.contains(host), "host": host])
            }
        }
    }
    private func poll() {
        guard !polling, !enabled.isEmpty else { return }
        polling = true
        findHost { port, _ in
            DispatchQueue.main.async {
                guard let port = port else { self.polling = false; return }
                let cookies = WKWebsiteDataStore.default().httpCookieStore
                self.headers(port, allowLogin: true) { headers in
                    guard let headers = headers else { self.polling = false; return }
                    self.get(port, "/api/machines", headers) { data, status in
                        if status == 401 { signIn(port: port, into: cookies) { self.polling = false }; return }
                        guard let machines = data?["machines"] as? [[String: Any]] else { self.polling = false; return }
                        let selfId = data?["current"] as? String ?? data?["selfId"] as? String ?? machines.first(where: { ($0["self"] as? Bool) == true })?["id"] as? String
                        let targets = machines.filter { ($0["id"] as? String).map { self.enabled.contains($0) } == true }
                        let group = DispatchGroup()
                        for machine in targets {
                            guard let id = machine["id"] as? String else { continue }
                            let revision = self.revisions[id] ?? 0
                            group.enter()
                            let prefix = id == selfId ? "" : "/r/\(id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")"
                            let after = self.cursors[id].flatMap { $0.addingPercentEncoding(withAllowedCharacters: .alphanumerics) }
                            self.get(port, prefix + "/api/notifications" + (after.map { "?after=\($0)" } ?? ""), headers) { data, _ in
                                defer { group.leave() }
                                guard self.enabled.contains(id), (self.revisions[id] ?? 0) == revision,
                                      let cursor = data?["cursor"] as? String, let events = data?["events"] as? [[String: Any]] else { return }
                                self.cursors[id] = cursor
                                for event in events where event["resolved"] as? Bool != true {
                                    guard event["host"] as? String == id, let key = event["key"] as? String,
                                          UUID(uuidString: key) != nil, !self.visible(id, key) else { continue }
                                    var notice = event.compactMapValues { $0 as? String }
                                    notice["hostName"] = String((machine["name"] as? String ?? id).prefix(120)); self.show(notice)
                                }
                            }
                        }
                        group.notify(queue: .main) { self.polling = false }
                    }
                }
            }
        }
    }
    private func headers(_ port: Int, allowLogin: Bool, completion: @escaping ([String: String]?) -> Void) {
        let store = WKWebsiteDataStore.default().httpCookieStore
        store.getAllCookies { all in
            DispatchQueue.main.async {
                let own = all.filter { ["stepsemble", "pi_harbor", "pi_web"].contains($0.name) && $0.domain == "127.0.0.1" && ($0.expiresDate ?? .distantFuture) > Date() }
                if !own.isEmpty { completion(HTTPCookie.requestHeaderFields(with: own)); return }
                guard allowLogin else { completion(nil); return }
                signIn(port: port, into: store) { self.headers(port, allowLogin: false, completion: completion) }
            }
        }
    }
    private func get(_ port: Int, _ path: String, _ headers: [String: String], completion: @escaping ([String: Any]?, Int) -> Void) {
        var request = URLRequest(url: hostURL(port, path)); request.timeoutInterval = 8; request.cachePolicy = .reloadIgnoringLocalCacheData
        for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
        let configuration = URLSessionConfiguration.ephemeral; configuration.httpShouldSetCookies = false
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        session.dataTask(with: request) { data, response, _ in
            let valid = (response as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) && $0.url?.host == "127.0.0.1" } == true
            let json = valid ? data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any] : nil
            DispatchQueue.main.async { completion(json, (response as? HTTPURLResponse)?.statusCode ?? 0); session.finishTasksAndInvalidate() }
        }.resume()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    private func show(_ notice: [String: String]) {
        guard let host = notice["host"], let key = notice["key"], let kind = notice["kind"],
              ["completed", "failed", "stopped", "approval", "test", "blockedGoal"].contains(kind) else { return }
        let content = UNMutableNotificationContent()
        let locale = UserDefaults.standard.string(forKey: "notificationLocale") ?? Text.language
        content.title = NativeNoticeText.text(kind, locale: locale)
        content.subtitle = notice["hostName"] ?? "Stepsemble"
        content.body = String((notice["title"] ?? "Stepsemble").prefix(120)); content.sound = .default
        content.threadIdentifier = "\(host):\(key)"; content.userInfo = notice
        center.add(UNNotificationRequest(identifier: "stepsemble:\(host):\(key)", content: content, trigger: nil))
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completion: @escaping (UNNotificationPresentationOptions) -> Void) {
        let notice = notification.request.content.userInfo
        if let host = notice["host"] as? String, let key = notice["key"] as? String, visible(host, key) { completion([]) }
        else { completion([.banner, .sound]) }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completion: @escaping () -> Void) {
        var notice: [String: String] = [:]
        for (key, value) in response.notification.request.content.userInfo { if let key = key as? String, let value = value as? String { notice[key] = value } }
        DispatchQueue.main.async { self.open(notice); completion() }
    }
}

private enum NativeNoticeText {
    static let kinds = ["completed", "failed", "stopped", "approval", "test", "blockedGoal"]
    static let tables: [String: [String]] = [
        "en": ["Work completed","Work failed","Work stopped","Approval needed","Notifications are ready","Work needs your attention"],
        "zh-Hant": ["工作已完成","工作失敗","工作已停止","需要你的核准","通知已準備就緒","工作需要你的處理"],
        "zh-Hans": ["工作已完成","工作失败","工作已停止","需要你的批准","通知已准备就绪","工作需要你的处理"],
        "ja": ["作業が完了しました","作業に失敗しました","作業が停止しました","承認が必要です","通知の準備ができました","作業への対応が必要です"],
        "ko": ["작업 완료","작업 실패","작업 중지","승인 필요","알림 준비 완료","작업 확인 필요"],
        "tr": ["İş tamamlandı","İş başarısız","İş durduruldu","Onay gerekiyor","Bildirimler hazır","İş için müdahale gerekiyor"],
        "fr": ["Travail terminé","Échec du travail","Travail arrêté","Approbation requise","Les notifications sont prêtes","Le travail nécessite votre attention"],
        "de": ["Arbeit abgeschlossen","Arbeit fehlgeschlagen","Arbeit angehalten","Genehmigung erforderlich","Benachrichtigungen sind bereit","Arbeit erfordert Ihre Aufmerksamkeit"],
        "es": ["Trabajo completado","El trabajo falló","Trabajo detenido","Se necesita aprobación","Las notificaciones están listas","El trabajo necesita tu atención"],
        "pt-BR": ["Trabalho concluído","O trabalho falhou","Trabalho interrompido","Aprovação necessária","As notificações estão prontas","O trabalho precisa da sua atenção"],
        "it": ["Lavoro completato","Lavoro non riuscito","Lavoro interrotto","Approvazione richiesta","Le notifiche sono pronte","Il lavoro richiede la tua attenzione"],
    ]
    static func text(_ kind: String, locale: String) -> String {
        guard let index = kinds.firstIndex(of: kind) else { return "Stepsemble" }
        return (tables[locale] ?? tables["en"]!)[index]
    }
}
