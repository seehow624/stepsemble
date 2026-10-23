// Loaded only by check-native-pi-chatgpt-speed.mjs in its private synthetic HOME.
import * as piAi from "@earendil-works/pi-ai";
import fs from "node:fs";
import zlib from "node:zlib";
import { nativeSpeedFixture } from "./pi-native-speed-fixture.mjs";
const record = (value: unknown) => fs.appendFileSync(process.env.STEPSEMBLE_FAKE_CAPTURE!, JSON.stringify(value) + "\n");
const token = (suffix = "first", account = "fake-account") => ["e30", Buffer.from(JSON.stringify({ sub: "fake-user", exp: 4102444800,
  "https://api.openai.com/auth": { chatgpt_account_id: account } })).toString("base64url"), suffix].join(".");
let redirectStatus = 0;
let offered = true, switchAtPayload = false, sequence = 0, held: FakeSocket | undefined, busyResult: Promise<unknown> | undefined, heldReady: (() => void) | undefined;
const capture = (transport: string, headers: Record<string, string>, body: any, connection?: number) => record({ kind: "wire", transport, connection,
  model: body.model, effort: body.reasoning?.effort, tier: body.service_tier ?? null, session: headers["session-id"],
  credential: headers.authorization === "Bearer " + token("rotated") ? "rotated" : headers.authorization === "Bearer " + token() ? "first" : "unexpected",
  accountMatches: headers["chatgpt-account-id"] === "fake-account", unrelatedHeader: headers["x-fixture"] });
const completed = () => ({ type: "response.completed", response: { id: "synthetic-response-" + sequence++, status: "completed", output: [],
  usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1, input_tokens_details: { cached_tokens: 0 } } } });
class FakeSocket extends EventTarget {
  readyState = 0;
  id = sequence++;
  headers: Record<string, string>;
  constructor(url: string, options: any) {
    super();
    if (url !== "wss://chatgpt.com/backend-api/codex/responses") throw new Error("unexpected fake socket route");
    if (redirectStatus) { record({ kind: "websocket-rejected" }); throw new Error("synthetic WS unavailable: exercise auto SSE fallback"); }
    this.headers = Object.fromEntries(new Headers(options.headers));
    record({ kind: "open", connection: this.id, session: this.headers["session-id"] });
    queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); });
  }
  send(body: string) {
    capture("websocket", this.headers, JSON.parse(body), this.id);
    if (body.includes("synthetic held")) { held = this; heldReady?.(); return; }
    setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(completed()) })), 0);
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; record({ kind: "close", connection: this.id, session: this.headers["session-id"] }); this.dispatchEvent(new Event("close")); }
}
export default function (pi: any) {
  globalThis.WebSocket = FakeSocket as any;
  globalThis.fetch = (async (url: any, options: any = {}) => {
    if (String(url) === "https://chatgpt.com/backend-api/codex/models?client_version=0.163.0") {
      if (options.method !== "GET" || options.redirect !== "error") throw new Error("unsafe metadata request");
      return new Response(JSON.stringify({ models: [{ slug: "gpt-6-astra", service_tiers: offered ? [{ id: "priority" }] : [] }], padding: "x".repeat(567000) }));
    }
    if (String(url) !== "https://chatgpt.com/backend-api/codex/responses") throw new Error("network forbidden");
    const headers = Object.fromEntries(new Headers(options.headers));
    const text = headers["content-encoding"] === "zstd" ? zlib.zstdDecompressSync(options.body).toString() : String(options.body);
    capture("sse", headers, JSON.parse(text));
    if (redirectStatus) {
      // Deterministic Fetch 307/308 semantics, not a real internet redirect.
      record({ kind: "redirect", status: redirectStatus, policy: options.redirect ?? "follow" });
      if (options.redirect === "error") throw new TypeError("synthetic redirect rejected");
      record({ kind: "redirect-target", paidBody: JSON.parse(text).service_tier === "priority", accountHeaderPresent: !!headers["chatgpt-account-id"] });
    }
    return new Response("data: " + JSON.stringify(completed()) + "\n\n", { headers: { "content-type": "text/event-stream" } });
  }) as any;
  pi.on("before_provider_request", async (_event: any, ctx: any) => {
    if (!switchAtPayload) return;
    switchAtPayload = false;
    fs.writeFileSync(process.env.STEPSEMBLE_FAKE_AUTH!, JSON.stringify({ "openai-codex": { type: "oauth", access: token("switched", "another-account"), refresh: "fake-only", expires: 4102444800000 } }));
    await ctx.modelRegistry.refresh({ allowNetwork: false });
  });
  pi.registerCommand("fixture", { handler: async (args: string, ctx: any) => {
    if (args.startsWith("redirect ")) redirectStatus = Number(args.slice("redirect ".length));
    if (args === "stale-probe") {
      let enter!: () => void, release!: () => void, waiting = false;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      // The actual bundled provider delegate, with an isolated fake lazy ctx.
      const f = await nativeSpeedFixture({ baseProvider: ctx.modelRegistry.runtime.builtins.get("openai-codex"), fetchImpl: async () => {
        if (waiting) { enter(); await gate; }
        return new Response(JSON.stringify({ models: [{ slug: "gpt-6-astra", service_tiers: [{ id: "priority" }] }] }));
      } });
      const cap = await f.command(); await f.command("set", "fast", cap.capability.fingerprint); waiting = true;
      const old = f.control.controller, result = f.dispatch().result(); await entered;
      old.abort(); f.control.controller = new AbortController(); const before = f.entries.length; release();
      const message = await result;
      record({ kind: "stale-owner", oldRequestBlocked: ["aborted", "error"].includes(message.stopReason),
        newTurnAborted: f.control.controller.signal.aborted, foreignReceiptCount: f.entries.length - before });
    }
    if (args === "rotate") {
      fs.writeFileSync(process.env.STEPSEMBLE_FAKE_AUTH!, JSON.stringify({ "openai-codex": { type: "oauth", access: token("rotated"), refresh: "fake-only", expires: 4102444800000 } }));
      await ctx.modelRegistry.refresh({ allowNetwork: false });
    }
    if (args === "revoke") offered = false;
    if (args === "offer") offered = true;
    if (args === "switch-at-payload") switchAtPayload = true;
    if (args === "auth-once") {
      const count = () => fs.existsSync(process.env.STEPSEMBLE_FAKE_HEADER_COUNT!) ? fs.readFileSync(process.env.STEPSEMBLE_FAKE_HEADER_COUNT!, "utf8").length : 0;
      const before = count(); await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      const base = ctx.modelRegistry.runtime.builtins.get("openai-codex"), wrapper = ctx.modelRegistry.getRegisteredNativeProvider("openai-codex");
      record({ kind: "composition", headerExecutions: count() - before, authPreserved: base.auth === wrapper.auth,
        refreshPreserved: base.refreshModels === wrapper.refreshModels, catalogPreserved: base.getModels === wrapper.getModels,
        configuredName: ctx.model.name, cleanupAvailable: typeof piAi.cleanupSessionResources === "function" });
    }
    if (args === "busy") {
      const started = new Promise<void>(resolve => { heldReady = resolve; });
      busyResult = ctx.modelRegistry.streamSimple(ctx.model, { messages: [{ role: "user", content: "synthetic held", timestamp: 1 }] },
        { sessionId: ctx.sessionManager.getSessionId(), transport: "websocket", signal: new AbortController().signal }).result();
      await started;
    }
    if (args === "finish-busy") {
      held!.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(completed()) }));
      await busyResult; held = undefined; busyResult = undefined; heldReady = undefined;
    }
    if (args === "warm-other") {
      await ctx.modelRegistry.streamSimple(ctx.model, { messages: [{ role: "user", content: "synthetic unrelated", timestamp: 1 }] },
        { sessionId: "synthetic-other-session", transport: "websocket", signal: new AbortController().signal }).result();
    }
  } });
}
