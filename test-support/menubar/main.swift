import AppKit
let slow = MenuBarCat.frameInterval(rate: 12, enabled: true, reducedMotion: false)!
let fast = MenuBarCat.frameInterval(rate: 120, enabled: true, reducedMotion: false)!
precondition(fast < slow && fast >= 0.05)
for rate in [0.0, Double.nan, Double.infinity] { precondition(MenuBarCat.frameInterval(rate: rate, enabled: true, reducedMotion: false) == 2) }
precondition(MenuBarCat.frameInterval(rate: 100, enabled: false, reducedMotion: false) == nil)
precondition(MenuBarCat.frameInterval(rate: 100, enabled: true, reducedMotion: true) == nil)
let value: [String: Any] = ["live": ["active": 1.0, "tokensPerSecond": 12.0, "estimated": true], "history": ["available": true, "tokensPerSecond": 3.0, "tokensPerMinute": 100.0]]
let summary = MenuBarActivityReader.summarize([value, value])
precondition(summary.rate == 24 && summary.burn == 200 && summary.estimated)
precondition(MenuBarActivityReader.summarize([nil]).rate == nil)
precondition(MenuBarActivityReader.summarize([["live": ["active": 1.0, "tokensPerSecond": 0.0], "history": ["available": true, "tokensPerSecond": 8.0]]]).rate == 8)
precondition(MenuBarActivityReader.summarize([["history": ["available": true, "tokensPerSecond": 8.0], "historyAgeMs": 45000.0]]).rate == nil)
precondition(MenuBarActivityReader.summarize([["history": ["available": true, "tokensPerSecond": 8.0], "historyAgeMs": 0.0]]).rate == 8)
let external: [String: Any] = ["live": ["active": 0.0, "tokensPerSecond": 0.0], "history": ["available": true, "tokensPerSecond": 48.0, "tokensPerMinute": 3600000.0]]
let waiting: [String: Any] = ["live": ["active": 1.0, "tokensPerSecond": 0.0]]
let whole = MenuBarActivityReader.summarize([external, waiting])
precondition(whole.rate == 48 && whole.burn == 3600000 && whole.motionRate == 3600 && whole.estimated)
precondition(MenuBarActivityReader.summarize([waiting]).motionRate == 4)
precondition(MenuBarCat.frameInterval(rate: whole.motionRate, enabled: true, reducedMotion: false)! == 0.025)
precondition(MenuBarCat.frameInterval(rate: 0, enabled: true, reducedMotion: false) == 2)
// Exercise the native transport while no WebKit process/window exists.
let port = Int(CommandLine.arguments[1])!, reader = MenuBarActivityReader()
var done = false
reader.poll(port: port, hosts: ["", "mbp"], cookie: "stepsemble=owned-test") { results in
    precondition(results.count == 2)
    precondition(MenuBarActivityReader.summarize(results).rate == 24)
    done = true
}
let end = Date().addingTimeInterval(8)
while !done && Date() < end { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
precondition(done, "Native transport did not finish")
reader.stop()
print("Native activity: independent network polling, multiple Hosts, idle, stale, speed scaling and reduced motion passed")
