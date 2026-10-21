import AppKit
import WebKit

// Run by scripts/check-mac-file-drag.mjs. Exercises the Mac app's drag code
// (WorkspaceWebView, FileDrag) without a mouse: the Host's media address
// is recognised (and nothing else is), the file downloads with the page's
// cookies, and the pasteboard item hands out the downloaded file.

let port = Int(CommandLine.arguments[1])!, token = CommandLine.arguments[2]
var failures = 0
func check(_ ok: Bool, _ what: String) { print(ok ? "ok   \(what)" : "FAIL \(what)"); if !ok { failures += 1 } }
func wait(_ seconds: Double, until done: () -> Bool) { let end = Date().addingTimeInterval(seconds); while !done() && Date() < end { RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05)) } }

_ = NSApplication.shared
let view = WorkspaceWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), configuration: WKWebViewConfiguration())
view.isHostURL = { $0.scheme == "http" && $0.host == "127.0.0.1" && $0.port == port }
view.load(URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/health")!))
wait(10) { !view.isLoading && view.url != nil }
view.evaluateJavaScript("fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:'\(token)'})}).then(r=>r.status)", completionHandler: nil)
// evaluateJavaScript does not wait for the fetch's promise; the cookie tells.
var cookies: [HTTPCookie] = []
view.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies = $0 }
wait(5) { !cookies.isEmpty }
check(cookies.contains { $0.name == "stepsemble" }, "the page is signed in (cookie)")

func pasteboard(with url: String) -> NSPasteboard {
  let board = NSPasteboard(name: NSPasteboard.Name("stepsemble-drag-test-\(UUID().uuidString)"))
  board.clearContents(); board.writeObjects([URL(string: url)! as NSURL]); return board
}
let media = "http://127.0.0.1:\(port)/api/assistant/media?path=%2FUsers%2Fonestep%2FMedia%2F"
check(view.testBotFile(pasteboard(with: media + "release-checklist.pdf"))?.absoluteString == media + "release-checklist.pdf&download=1", "a Bot's PDF address becomes its download")
check(view.testBotFile(pasteboard(with: media + "a%2Bb%20c%E5%A0%B1.pdf"))?.absoluteString == media + "a%2Bb%20c%E5%A0%B1.pdf&download=1", "a name's +, space and Chinese keep their encoding")
check(view.testBotFile(pasteboard(with: media + "x.pdf&download=1"))?.absoluteString == media + "x.pdf&download=1", "a download link stays as it is")
check(view.testBotFile(pasteboard(with: "http://127.0.0.1:\(port)/r/mbp/api/assistant/media?path=%2Ftmp%2Fa.png"))?.path == "/r/mbp/api/assistant/media", "another computer's file too")
check(view.testBotFile(pasteboard(with: "http://127.0.0.1:\(port)/workspace.html")) == nil, "any other address of the Host is WebKit's own drag")
check(view.testBotFile(pasteboard(with: "http://127.0.0.1:\(port + 1)/api/assistant/media?path=%2Fx.pdf")) == nil, "another Host's address is WebKit's own drag")
check(view.testBotFile(pasteboard(with: "https://example.com/api/assistant/media?path=%2Fx.pdf")) == nil, "a web address is WebKit's own drag")
check(view.testBotFile(pasteboard(with: media.replacingOccurrences(of: "?path=%2FUsers%2Fonestep%2FMedia%2F", with: ""))) == nil, "no file named, no file drag")

let sizes = ["pdf": Int(CommandLine.arguments[3])!, "png": Int(CommandLine.arguments[4])!]
for (name, size) in [("release-checklist.pdf", sizes["pdf"]!), ("cover-72h.png", sizes["png"]!)] {
  let drag = FileDrag(source: URL(string: media + name + "&download=1")!, webView: view)
  drag.start()
  // A drop asks at once: the item waits for the download.
  let board = NSPasteboard(name: NSPasteboard.Name("stepsemble-drop-\(UUID().uuidString)"))
  board.clearContents(); board.writeObjects([drag.item])
  let given = board.string(forType: .fileURL).flatMap(URL.init(string:))
  let attributes = given.flatMap { try? FileManager.default.attributesOfItem(atPath: $0.path) }
  check(given?.lastPathComponent == name, "\(name): the dropped item is the file \(given?.lastPathComponent ?? "nil")")
  check((attributes?[.size] as? Int) == size, "\(name): \(attributes?[.size] ?? "no") bytes, as the Bot sent (\(size))")
}
let missing = FileDrag(source: URL(string: media + "gone.pdf&download=1")!, webView: view)
missing.start()
let board = NSPasteboard(name: NSPasteboard.Name("stepsemble-drop-missing")); board.clearContents(); board.writeObjects([missing.item])
check(board.string(forType: .fileURL) == nil, "a file the Host no longer has gives no file")
print(failures == 0 ? "ALL PASSED" : "\(failures) FAILED")
exit(failures == 0 ? 0 : 1)
