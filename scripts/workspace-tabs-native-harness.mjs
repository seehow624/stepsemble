#!/usr/bin/env node
// Build the actual WorkspaceWindow/drag code into a disposable, non-production app.
// Usage: node scripts/workspace-tabs-native-harness.mjs /tmp/owned-output http://127.0.0.1:PORT TOKEN
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
const [output, origin, token] = process.argv.slice(2), url = new URL(origin);
if (!output?.startsWith("/tmp/") || url.hostname !== "127.0.0.1" || url.protocol !== "http:" || !url.port || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error("Owned /tmp output and synthetic loopback fixture required");
await fs.mkdir(output, { recursive: true });
const source = new URL("../macos/Stepsemble/", import.meta.url);
let main = await fs.readFile(new URL("main.swift", source), "utf8");
function replace(old, next) { if (!main.includes(old)) throw new Error("Harness seam changed: " + old.slice(0, 80)); main = main.replace(old, next); }
replace("private let startsHost = LaunchAgent.read().startsThroughApp", "private let startsHost = false");
replace("configuration.websiteDataStore = .default()", "configuration.websiteDataStore = .nonPersistent()");
replace("        notifications.start()\n        menuBar.start()", "        // Isolated harness never discovers a Host, starts notifications or reads account data.");
const begin = main.indexOf("    func connect() {", main.indexOf("final class WorkspaceWindow"));
const end = main.indexOf("    private func showWaiting()", begin);
if (begin < 0 || end < 0) throw new Error("Connect seam missing");
main = main.slice(0, begin) + `    func connect() {
        port = ${url.port}
        let cookie = HTTPCookie(properties: [.domain: "127.0.0.1", .path: "/", .name: "stepsemble", .value: "${token}"])!
        webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) {
            self.webView.load(URLRequest(url: URL(string: "${url.origin}" + self.path)!))
        }
    }

` + main.slice(end);
replace('        sendChrome()\n        if let notice = pendingNotice', `        sendChrome()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            self.webView.evaluateJavaScript("JSON.stringify({url:location.href,ready:document.readyState,body:document.body.innerText.slice(0,400),tabs:document.querySelectorAll('.workspace-tab').length,frames:document.querySelectorAll('iframe').length,regions:[...document.querySelectorAll('.workspace-tab-label')].map(x=>({text:x.textContent,rect:x.getBoundingClientRect().toJSON()})),size:[innerWidth,innerHeight]})") { value, error in
                let text = (value as? String) ?? String(describing: error)
                try? text.write(toFile: "${output}/dom-diagnostic.json", atomically: true, encoding: .utf8)
            }
        }
        if let notice = pendingNotice`);
// Never foreground an app from automation. A deliberate click can activate it;
// the product's isActive/isKeyWindow cancellation guards remain intact.
main = main.replaceAll("NSApp.activate(ignoringOtherApps: true)", "_ = 0 /* harness does not foreground */").replaceAll("window.makeKeyAndOrderFront(nil)", "window.orderBack(nil)");
replace('let arguments = Array(CommandLine.arguments.dropFirst())', 'let arguments: [String] = []');
await fs.writeFile(path.join(output, "main.swift"), main);
const files = [];
for (const name of await fs.readdir(source)) if (name.endsWith(".swift") && name !== "main.swift") { await fs.copyFile(new URL(name, source), path.join(output, name)); files.push(path.join(output, name)); }
const bundle = path.join(output, "StepsembleTabsHarness.app"), contents = path.join(bundle, "Contents");
await fs.mkdir(path.join(contents, "MacOS"), { recursive: true });
await fs.writeFile(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.stepsemble.tabs-harness</string><key>CFBundleName</key><string>Stepsemble Tabs Harness</string><key>CFBundleExecutable</key><string>TabsHarness</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>1.0</string></dict></plist>`);
execFileSync("xcrun", ["swiftc", "-module-cache-path", path.join(output, "swift-cache"), path.join(output, "main.swift"), ...files, "-o", path.join(contents, "MacOS/TabsHarness")], { stdio: "inherit" });
console.log(JSON.stringify({ bundle, bundleId: "dev.stepsemble.tabs-harness", fixture: url.origin, productionHostDiscovery: false, foreground: false, cases: ["click without threshold", "same-pane reorder", "24 tabs active visibility", "owned mouseUp outside workspace", "Escape outside", "display-boundary rejection", "cross-window ACK", "Cmd+Option arrows inside input", "Cmd+W on popup"] }));
