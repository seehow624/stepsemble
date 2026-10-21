#!/usr/bin/env node
// macOS only. Builds the Mac app's own drag code (WorkspaceWebView and
// FileDrag, between the "Dragging a Bot's file out" and "Downloads" marks of
// macos/Stepsemble/main.swift) into a disposable harness and runs it against a
// disposable Host and fake Hermes: a Bot's file address is recognised and
// nothing else is, the file downloads with the page's sign-in, and the drop is
// handed the file itself. No mouse, window or real Hermes is involved; the
// drag session itself is AppKit's.
//   node scripts/check-mac-file-drag.mjs
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createAssistantPreview } from "./assistant-preview.mjs";

if (process.platform !== "darwin") { console.log(JSON.stringify({ case: "Mac app file drag", result: "skipped", reason: "macOS only" })); process.exit(0); }
const root = fileURLToPath(new URL("../", import.meta.url));
const work = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-file-drag-"));
// A one-page PDF and a 2×2 PNG, small enough to write out here.
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR42mP8z8DwnwEJMDIwMjAwAAA/WAQDL2hmbgAAAABJRU5ErkJggg==", "base64");
const preview = await createAssistantPreview({ hermes: { authRequired: false } });
try {
  preview.fake.addFile("/Users/onestep/Media/release-checklist.pdf", PDF);
  preview.fake.addFile("/Users/onestep/Media/cover-72h.png", PNG);
  // The Host serves only files a Bot sent in a conversation that was opened.
  const chat = preview.fake.addSession("default", "Bot Chat", { source: "tui" });
  chat.messages.push({ role: "user", text: "the files" }, { role: "assistant", text: "MEDIA:/Users/onestep/Media/release-checklist.pdf\nMEDIA:/Users/onestep/Media/cover-72h.png" });
  const login = await fetch(preview.origin + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: preview.token }) });
  const cookie = login.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
  const opened = await fetch(preview.origin + "/api/assistant/bot-chat", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ profile: "default" }) });
  if (!opened.ok) throw new Error("the Bot Chat did not open: " + opened.status);
  const main = await fs.readFile(path.join(root, "macos/Stepsemble/main.swift"), "utf8");
  const start = main.indexOf("// MARK: Dragging a Bot's file out"), end = main.indexOf("// MARK: Downloads", start);
  if (start < 0 || end < 0) throw new Error("the drag code's marks moved in main.swift");
  const drag = main.slice(start, end).replace("    private func botFile(on pasteboard", "    fileprivate func botFile(on pasteboard");
  if (!drag.includes("fileprivate func botFile")) throw new Error("botFile(on:) changed; update the harness");
  await fs.writeFile(path.join(work, "drag.swift"), "import AppKit\nimport WebKit\n" + drag
    + "\nextension WorkspaceWebView { func testBotFile(_ pasteboard: NSPasteboard) -> URL? { botFile(on: pasteboard) } }\n");
  await fs.copyFile(path.join(root, "test-support/mac-file-drag-harness.swift"), path.join(work, "main.swift"));
  execFileSync("xcrun", ["swiftc", "-swift-version", "5", "-target", `${os.arch() === "arm64" ? "arm64" : "x86_64"}-apple-macos12.0`,
    "-module-cache-path", path.join(work, "swift-cache"), "-o", path.join(work, "harness"), path.join(work, "drag.swift"), path.join(work, "main.swift")], { stdio: "inherit" });
  // Not execFileSync: the fake Hermes serving the files runs in this process.
  const { stdout: output } = await promisify(execFile)(path.join(work, "harness"), [new URL(preview.origin).port, preview.token, String(PDF.length), String(PNG.length)],
    { encoding: "utf8", timeout: 120_000, env: { ...process.env, TMPDIR: work + "/" } }).catch(error => ({ stdout: error.stdout || String(error) }));
  process.stdout.write(output);
  if (!/^ALL PASSED$/m.test(output)) throw new Error("the Mac app's file drag failed");
  console.log(JSON.stringify({ case: "Mac app file drag", result: "passed", modelCalls: 0, mouse: false }));
} finally {
  await preview.close();
  await fs.rm(work, { recursive: true, force: true });
}
