import AppKit

/// Five template frames from TokenBar/tokcat (MIT; bundled notice). Frame
/// timing follows whole-machine usage; a quiet machine makes one slow rotation.
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
        guard enabled, !reducedMotion else { return nil }
        guard rate.isFinite, rate > 0 else { return 2 } // one rotation per 10s
        // 5 frames per rotation; output and total-token load share a bounded scale.
        // Heavy machine-wide use reaches TokenBar's 40 fps ceiling.
        return max(0.025, 0.5 / (1 + sqrt(min(rate, 10000)) / 2))
    }
    init(button: NSStatusBarButton) {
        self.button = button
        frames = (0..<5).compactMap { index in
            guard let url = Bundle.main.url(forResource: String(format: "frame-%02d", index), withExtension: "png", subdirectory: "MenuBarCat"),
                  let image = NSImage(contentsOf: url) else { return nil }
            image.size = NSSize(width: 18, height: 18); image.isTemplate = true; return image
        }
        if let first = frames.first { button.image = first }
        update(rate: 0, enabled: true)
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
            // Lost samples settle back to idle, never keep the last high speed.
            if Date().timeIntervalSince(self.updated) >= 10 && self.rate > 0 {
                self.rate = 0; self.reschedule(); return
            }
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
