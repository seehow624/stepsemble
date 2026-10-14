import AppKit
import WebKit

/// A read-only companion to the workspace. The page shares the app's existing
/// loopback sign-in; no token or remote-host cookie is ever sent into JavaScript.
private final class MenuBarRelay: NSObject, WKScriptMessageHandler {
    weak var owner: MenuBarPanel?
    init(_ owner: MenuBarPanel) { self.owner = owner }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) { owner?.received(message) }
}

final class MenuBarPanel: NSObject, WKNavigationDelegate {
    private let open: (String, String) -> Void
    private var item: NSStatusItem?
    private let popover = NSPopover()
    private var webView: WKWebView!
    private var port: Int?
    private var timer: Timer?
    private var activityTimer: Timer?
    private var cat: MenuBarCat?
    private let activityReader = MenuBarActivityReader()
    private var activityHosts: [String] = []
    private var activityEpoch = 0
    private var activitySample = MenuBarActivityReader.Sample()
    private var activityResults: [[String: Any]?] = []
    private var animate = true
    private var metric = "limits"
    private var metricLabel = ""
    private var locale = "en"
    private var cookieReading = false
    private var escapeMonitor: Any?
    private var connecting = false
    private var loaded = false
    private var acceptedResponse = false
    private lazy var relay = MenuBarRelay(self)

    init(open: @escaping (String, String) -> Void) { self.open = open; super.init() }
    func start() {
        guard item == nil else { return }
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = item?.button {
            let icon = Bundle.main.url(forResource: "MenuBarIcon", withExtension: "png").flatMap { NSImage(contentsOf: $0) }
                ?? NSImage(systemSymbolName: "chart.bar.xaxis", accessibilityDescription: "Stepsemble")
            icon?.size = NSSize(width: 17, height: 17); icon?.isTemplate = true
            button.image = icon; button.imagePosition = .imageLeading
            button.title = " —"; button.target = self; button.action = #selector(toggle(_:))
            button.setAccessibilityLabel("Stepsemble · Limits & usage")
            button.toolTip = "Stepsemble · Limits & usage"
            cat = MenuBarCat(button: button)
        }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = "Stepsemble/\(appVersion)"
        configuration.userContentController.add(relay, name: "stepsemble")
        configuration.userContentController.addUserScript(WKUserScript(source: "window.StepsembleMenubarNativePolling = true", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 380, height: 550), configuration: configuration)
        webView.navigationDelegate = self
        let controller = NSViewController(); controller.view = webView
        popover.contentViewController = controller; popover.contentSize = NSSize(width: 380, height: 550)
        popover.behavior = .transient; popover.animates = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.refresh() }
        let heartbeat = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            if self.activityHosts.isEmpty && self.loaded {
                self.webView.evaluateJavaScript("window.StepsembleMenubarActivity?.()", completionHandler: nil)
            } else { self.refreshActivity() }
        }
        activityTimer = heartbeat; RunLoop.main.add(heartbeat, forMode: .common)
        escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard event.keyCode == 53, self?.popover.isShown == true else { return event }
            self?.popover.performClose(nil); return nil
        }
        connect()
    }
    @objc func toggle(_ sender: Any?) {
        if popover.isShown { popover.performClose(sender); return }
        guard let button = item?.button else { return }
        let visibleHeight = (button.window?.screen ?? NSScreen.main)?.visibleFrame.height ?? 700
        popover.contentSize = NSSize(width: 380, height: max(300, min(600, visibleHeight - 40)))
        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        webView.window?.setAccessibilityLabel("Stepsemble · Limits & usage")
        webView.window?.makeKey(); renderNativeActivity(); refresh()
    }
    func stop() {
        timer?.invalidate(); activityTimer?.invalidate(); cat?.stop(); activityReader.stop(); activityEpoch += 1
        if let monitor = escapeMonitor { NSEvent.removeMonitor(monitor); escapeMonitor = nil }
        popover.performClose(nil)
        if let item = item { NSStatusBar.system.removeStatusItem(item) }; item = nil
    }
    private func refreshActivity() {
        guard let port = port, !activityHosts.isEmpty, !cookieReading else { return }
        let epoch = activityEpoch
        cookieReading = true
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self = self else { return }
            self.cookieReading = false
            guard self.activityEpoch == epoch else { return }
            let local = cookies.filter { $0.name == "stepsemble" && $0.domain == "127.0.0.1" && ($0.expiresDate ?? .distantFuture) > Date() }
            let cookie = HTTPCookie.requestHeaderFields(with: local)["Cookie"] ?? ""
            guard !cookie.isEmpty else {
                self.activityEpoch += 1; self.activityReader.cancel()
                self.activitySample = MenuBarActivityReader.Sample(); self.activityResults = [nil]
                self.cat?.update(rate: 0, enabled: self.animate); self.updateActivityTitle(); self.renderNativeActivity(); return
            }
            self.activityReader.poll(port: port, hosts: self.activityHosts, cookie: cookie) { [weak self] values in
                guard let self = self, self.activityEpoch == epoch else { return }
                self.activitySample = MenuBarActivityReader.summarize(values)
                self.activityResults = values
                self.cat?.update(rate: self.activitySample.motionRate, enabled: self.animate)
                self.updateActivityTitle()
                self.renderNativeActivity()
            }
        }
    }
    private func renderNativeActivity() {
        // Never queue work into a suspended, invisible WebKit process.
        guard popover.isShown, !activityResults.isEmpty else { return }
        let values: [Any] = activityResults.map { $0 as Any? ?? NSNull() }
        if let data = try? JSONSerialization.data(withJSONObject: values), let json = String(data: data, encoding: .utf8) {
            webView.evaluateJavaScript("window.StepsembleMenubarNativeActivity?.(\(json))", completionHandler: nil)
        }
    }
    private func updateActivityTitle() {
        guard metric == "rate" || metric == "burn" else { return }
        let value = metric == "rate" ? activitySample.rate : activitySample.burn
        let formatter = NumberFormatter(); formatter.locale = Locale(identifier: locale); formatter.numberStyle = .decimal
        formatter.maximumFractionDigits = metric == "rate" && (value ?? 0) < 10 ? 1 : 0
        let scale = metric == "burn" && (value ?? 0) >= 1_000_000 ? 1_000_000.0 : metric == "burn" && (value ?? 0) >= 1_000 ? 1_000.0 : 1
        if scale > 1 { formatter.maximumFractionDigits = 1 }
        let number = (value.flatMap { formatter.string(from: NSNumber(value: $0 / scale)) } ?? "—") + (scale == 1_000_000 ? "M" : scale == 1_000 ? "K" : "")
        let text = (metric == "rate" && activitySample.estimated && value != nil ? "≈ " : "") + number + (metric == "rate" ? " tok/s" : " tok/min")
        item?.button?.title = " " + text
        item?.button?.toolTip = "Stepsemble · \(metricLabel) · \(text)"
        item?.button?.setAccessibilityLabel("Stepsemble · \(metricLabel) · \(text)")
    }
    private func refresh() {
        if loaded { webView.evaluateJavaScript("window.StepsembleMenubarRefresh?.()", completionHandler: nil) }
        else { connect() }
    }
    private func connect() {
        guard !connecting else { return }
        connecting = true
        findHost { [weak self] port, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                guard let port = port else {
                    self.connecting = false
                    self.item?.button?.title = " —"
                    self.webView.loadHTMLString("<html><body style='background:#151515;color:#aaa;font:14px -apple-system;padding:24px'>Stepsemble<br><br>Waiting for this computer’s Host…</body></html>", baseURL: nil)
                    return
                }
                if self.port != port { self.activityEpoch += 1; self.activityReader.cancel() }
                self.port = port
                signIn(port: port, into: self.webView.configuration.websiteDataStore.httpCookieStore) {
                    guard self.port == port else { self.connecting = false; return }
                    self.acceptedResponse = false
                    self.webView.load(URLRequest(url: hostURL(port, "/menubar.html")))
                }
            }
        }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        connecting = false; loaded = acceptedResponse && webView.url?.path == "/menubar.html"
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { connecting = false; loaded = false; item?.button?.title = " —" }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { connecting = false; loaded = false; item?.button?.title = " —" }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        let own = url.scheme == "http" && url.host == "127.0.0.1" && url.port == port && url.path == "/menubar.html"
        if !own && url.absoluteString != "about:blank" { connecting = false; loaded = false }
        decisionHandler(own || url.absoluteString == "about:blank" ? .allow : .cancel)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        connecting = false; loaded = false; item?.button?.title = " —"; connect()
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard navigationResponse.isForMainFrame else { decisionHandler(.allow); return }
        if let response = navigationResponse.response as? HTTPURLResponse {
            acceptedResponse = response.statusCode == 200 && response.mimeType == "text/html"
            if !acceptedResponse { connecting = false; loaded = false; item?.button?.title = " —" }
            decisionHandler(acceptedResponse ? .allow : .cancel)
        } else { decisionHandler(.allow) }
    }
    fileprivate func received(_ message: WKScriptMessage) {
        guard message.webView === webView, message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.host == "127.0.0.1", message.frameInfo.securityOrigin.port == port,
              message.frameInfo.securityOrigin.protocol == "http", webView.url?.path == "/menubar.html",
              let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        if type == "menubar-summary", let text = body["text"] as? String, text.count <= 32,
           !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
           let label = body["label"] as? String, label.count <= 80 {
            item?.button?.title = text.isEmpty ? "" : " " + text
            item?.button?.imagePosition = text.isEmpty ? .imageOnly : .imageLeading
            item?.button?.toolTip = "Stepsemble · \(label) · \(text)"
            item?.button?.setAccessibilityLabel("Stepsemble · \(label) · \(text)")
            metric = body["metric"] as? String ?? "limits"; metricLabel = label
            if let value = body["locale"] as? String, value.count <= 40 { locale = value }
            let enabled = body["animate"] as? Bool ?? true
            if animate != enabled { animate = enabled; cat?.update(rate: activitySample.motionRate, enabled: enabled) }
            if let hosts = body["activityHosts"] as? [String], hosts.count <= 32,
               hosts.allSatisfy({ $0.isEmpty || $0.range(of: "^[a-zA-Z0-9_-]{1,128}$", options: .regularExpression) != nil }) {
                let unique = Array(Set(hosts)).sorted()
                if unique != activityHosts {
                    activityHosts = unique; activityEpoch += 1; activityReader.cancel()
                    activitySample = MenuBarActivityReader.Sample(); activityResults = []; cat?.update(rate: 0, enabled: animate)
                    refreshActivity()
                }
            } else if body["activityHosts"] == nil && activityHosts.isEmpty {
                // Older Host pages still supply their measured rate over the
                // bridge while the App and Host are updated independently.
                let rate = body["rate"] as? Double ?? 0
                activitySample = MenuBarActivityReader.Sample(rate: rate.isFinite ? max(0, rate) : nil)
                cat?.update(rate: activitySample.motionRate, enabled: animate)
            }
            updateActivityTitle()
        } else if type == "menubar-open", let host = body["host"] as? String,
                  host.isEmpty || host.range(of: "^[a-zA-Z0-9_-]{1,128}$", options: .regularExpression) != nil {
            let agent = body["agent"] as? String ?? ""
            guard agent.isEmpty || agent.range(of: "^[a-zA-Z0-9_-]{1,80}$", options: .regularExpression) != nil else { return }
            popover.performClose(nil); open(host, agent)
        }
    }
}
