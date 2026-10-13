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
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 380, height: 550), configuration: configuration)
        webView.navigationDelegate = self
        let controller = NSViewController(); controller.view = webView
        popover.contentViewController = controller; popover.contentSize = NSSize(width: 380, height: 550)
        popover.behavior = .transient; popover.animates = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.refresh() }
        let heartbeat = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
            guard let self = self, self.loaded else { return }
            self.webView.evaluateJavaScript("window.StepsembleMenubarActivity?.()", completionHandler: nil)
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
        webView.window?.makeKey(); refresh()
    }
    func stop() {
        timer?.invalidate(); activityTimer?.invalidate(); cat?.stop()
        if let monitor = escapeMonitor { NSEvent.removeMonitor(monitor); escapeMonitor = nil }
        popover.performClose(nil)
        if let item = item { NSStatusBar.system.removeStatusItem(item) }; item = nil
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
            let rate = body["rate"] as? Double ?? 0
            cat?.update(rate: min(max(0, rate.isFinite ? rate : 0), 100000), enabled: body["animate"] as? Bool ?? true)
        } else if type == "menubar-open", let host = body["host"] as? String,
                  host.isEmpty || host.range(of: "^[a-zA-Z0-9_-]{1,128}$", options: .regularExpression) != nil {
            let agent = body["agent"] as? String ?? ""
            guard agent.isEmpty || agent.range(of: "^[a-zA-Z0-9_-]{1,80}$", options: .regularExpression) != nil else { return }
            popover.performClose(nil); open(host, agent)
        }
    }
}
