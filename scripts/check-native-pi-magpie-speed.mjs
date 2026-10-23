// Run installed Pi API adapters with an injected fetch. No request reaches a
// socket, no credential files are read, and no installed files are modified.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { installPiSpeed } from "../server/pi-speed-runtime.mjs";
const { createMagpieGatewayService } = createRequire(import.meta.url)("../server/magpie-gateway-service");
const dist = process.argv[2];
assert(dist && path.isAbsolute(dist), "absolute installed pi-ai dist directory required");
const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-pi-speed-"));
const captures = [];
let offered = true;
try {
  await fs.mkdir(path.join(home, ".config", "magpie"), { recursive: true });
  const gateway = createMagpieGatewayService({ home, env: { HOME: home, PATH: "" }, fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "codex/fixture-gpt", owned_by: "codex", native_endpoints: ["/v1/responses"], service_tiers: offered ? [{ id: "priority" }] : [] }] })) });
  for (const api of ["openai-responses", "openai-completions", "anthropic-messages"]) {
    const model = { id: "codex/fixture-gpt", name: "Synthetic", provider: "magpie", api, baseUrl: gateway.origin + (api === "anthropic-messages" ? "" : "/v1"), reasoning: true,
      input: ["text"], contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    const hooks = {}, commands = {}, entries = [];
    let controller = new AbortController();
    const ctx = { model, abort: () => controller.abort(), isIdle: () => true, sessionManager: { getBranch: () => entries } };
    installPiSpeed({ on: (name, fn) => { hooks[name] = fn; }, registerCommand: (name, spec) => { commands[name] = spec.handler; }, appendEntry: (_type, data) => entries.push({ type: "custom", customType: "stepsemble-speed", data }) },
      { capability: selected => gateway.speedCapability({ baseUrl: selected.baseUrl, model: selected.id, api: selected.api }) });
    hooks.session_start({}, ctx);
    const cap = await gateway.speedCapability({ baseUrl: model.baseUrl, model: model.id, api });
    const { stream } = await import(pathToFileURL(path.join(dist, "api", api + ".js")));
    for (const speed of ["fast", "standard"]) {
      await commands["stepsemble-speed"](JSON.stringify({ action: "set", speed, nonce: "capture-" + speed, fingerprint: cap.fingerprint }), ctx);
      assert.equal(entries.at(-1).data.ok, true);
      const before = captures.length;
      const events = stream(model, { systemPrompt: "synthetic", messages: [{ role: "user", content: "synthetic", timestamp: 1 }] }, {
        apiKey: "sk-synthetic-only", maxRetries: 0, reasoningEffort: "high", thinkingEnabled: false,
        onPayload: payload => hooks.before_provider_request({ payload }, ctx),
        fetch: async (url, options) => {
          captures.push({ api, speed, url: String(url), body: JSON.parse(options.body), headers: Object.fromEntries(new Headers(options.headers)) });
          return new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "synthetic capture complete" } }), { status: 400, headers: { "content-type": "application/json" } });
        },
      });
      for await (const _event of events) { /* consume the synthetic error */ }
      assert.equal(captures.length, before + 1, api);
      const capture = captures.at(-1); assert.equal(capture.body.model, model.id);
      if (api === "anthropic-messages") {
        assert.equal(new URL(capture.url).origin, gateway.origin);
        assert.equal(new URL(capture.url).pathname, "/v1/messages");
        assert.equal(capture.body.speed, speed === "fast" ? "fast" : undefined);
        assert.equal((capture.headers["anthropic-beta"] || "").includes("fast-mode-2026-02-01"), speed === "fast");
      } else {
        assert.equal(capture.url, gateway.origin + (api === "openai-responses" ? "/v1/responses" : "/v1/chat/completions"));
        assert.equal(capture.body.service_tier, speed === "fast" ? "priority" : undefined);
        if (api === "openai-responses") assert.equal(capture.body.reasoning.effort, "high");
        else assert.equal(capture.body.reasoning_effort, "high");
      }
    }
    await commands["stepsemble-speed"](JSON.stringify({ action: "set", speed: "fast", nonce: "revoked", fingerprint: cap.fingerprint }), ctx);
    offered = false; controller = new AbortController();
    const before = captures.length;
    const revoked = stream(model, { messages: [{ role: "user", content: "must not dispatch", timestamp: 1 }] }, {
      apiKey: "sk-synthetic-only", maxRetries: 0, signal: controller.signal,
      onPayload: payload => hooks.before_provider_request({ payload }, ctx),
      fetch: async () => { captures.push({ unexpected: true }); throw new Error("revoked request dispatched"); },
    });
    for await (const _event of revoked) { /* aborted before injected fetch */ }
    assert.equal(controller.signal.aborted, true); assert.equal(captures.length, before, "revoked metadata must stop even a Standard fallback request");
    offered = true;
  }
  console.log(JSON.stringify({ result: "passed", captures: captures.map(({ api, speed, url, body }) => ({ api, speed, url, model: body.model, tier: body.service_tier ?? body.speed ?? null })), paidModelCalls: 0, networkCalls: 0 }));
} finally { await fs.rm(home, { recursive: true, force: true }); }
