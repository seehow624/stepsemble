import AppKit

/// Five template frames from TokenBar/tokcat (MIT; bundled notice). Frame
/// timing follows fresh output measurements, never a busy flag alone.
final class MenuBarCat {
    private weak var button: NSStatusBarButton?
    private let frames: [NSImage]
    private var timer: Timer?
    private var index = 0
    private var interval: TimeInterval?
    private var rate = 0.0
    private var enabled = true
    private var updated = Date.distantPast
    private var motionObserver: NSObjectProtocol?

    static func frameInterval(rate: Double, enabled: Bool, reducedMotion: Bool) -> TimeInterval? {
        guard enabled, !reducedMotion, rate.isFinite, rate > 0 else { return nil }
        // 5 frames per rotation: 1 tok/s is relaxed, 100 tok/s is lively.
        return max(0.05, 0.5 / (1 + sqrt(min(rate, 10000)) / 2))
    }
    init(button: NSStatusBarButton) {
        self.button = button
        frames = (0..<5).compactMap { index in
            guard let url = Bundle.main.url(forResource: String(format: "frame-%02d", index), withExtension: "png", subdirectory: "MenuBarCat"),
                  let image = NSImage(contentsOf: url) else { return nil }
            image.size = NSSize(width: 18, height: 18); image.isTemplate = true; return image
        }
        if let first = frames.first { button.image = first }
        motionObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) { [weak self] _ in self?.reschedule() }
    }
    func update(rate: Double, enabled: Bool) {
        self.rate = rate.isFinite ? max(0, rate) : 0; self.enabled = enabled; updated = Date(); reschedule()
    }
    private func reschedule() {
        let next = Self.frameInterval(rate: rate, enabled: enabled, reducedMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
        guard next != interval else { return }
        timer?.invalidate(); timer = nil; interval = next
        guard let next = next, !frames.isEmpty else { index = 0; if let first = frames.first { button?.image = first }; return }
        let timer = Timer(timeInterval: next, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            // Stop on a stalled WebView/network instead of spinning forever.
            guard Date().timeIntervalSince(self.updated) < 10 else { self.rate = 0; self.reschedule(); return }
            self.index = (self.index + 1) % self.frames.count; self.button?.image = self.frames[self.index]
        }
        self.timer = timer; RunLoop.main.add(timer, forMode: .common)
    }
    func stop() {
        timer?.invalidate(); timer = nil
        if let observer = motionObserver { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
        motionObserver = nil
    }
    deinit { stop() }
}
